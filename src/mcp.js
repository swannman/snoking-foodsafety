// Remote MCP server at /mcp — lets any MCP client (Claude, etc.) query the inspection data.
//
// Hand-rolled on the Streamable HTTP transport rather than the agents SDK: a stateless,
// tools-only, no-auth server is just JSON-RPC 2.0 over POST, and doing it directly keeps the
// Worker dependency-free (no Durable Objects, no bundler config). Statelessness is spec-legal:
// we never issue an Mcp-Session-Id, answer every POST with plain application/json instead of
// an SSE stream, and 405 the GET that would open one.
//
// Read-only by construction — every tool is a SELECT against D1.

const PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const SERVER_INFO = { name: "snoking-foodsafety", title: "Sno/King Food Safety", version: "1.0.0" };
const INSTRUCTIONS =
  "Food-safety inspection data for King and Snohomish counties, Washington (Seattle metro area). " +
  "One record per food establishment with a unified rating: 1=Excellent (best), 2=Good, 3=Okay, 4=Needs to Improve (worst) — LOWER IS BETTER. " +
  "King County ratings are the county's own published grade; Snohomish County doesn't publish one, so its rating is derived from the same WA food code using King's method (comparable by design). " +
  "Data refreshes from county records about daily. " +
  "Start with search_restaurants (or get_overview for valid cuisine keys and dataset totals); get_restaurant returns full violation and inspection history. " +
  "Records with food_truck: true are mobile units (cuisine 'foodtruck'): the address is the operator's registered base, NOT where they vend — don't tell people to eat at that address. " +
  "Every establishment also has a human-readable page at the returned page_url — cite that when answering people.";

// Browser-based MCP clients (claude.ai custom connectors) do a CORS preflight before POSTing.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Max-Age": "86400",
};

const TOOLS = [
  {
    name: "search_restaurants",
    description:
      "Search food establishments in King and Snohomish counties, WA. Ratings: 1=Excellent (best) … 4=Needs to Improve (worst). " +
      "Give at least one of query/city/cuisine/county. Returns compact summaries — follow up with get_restaurant for violations and history.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring of the establishment name, e.g. 'taqueria'" },
        city: { type: "string", description: "City name, e.g. 'Bothell'" },
        cuisine: { type: "string", description: "Cuisine key, e.g. 'mexican' — get_overview lists valid keys with counts" },
        county: { type: "string", enum: ["king", "snohomish"], description: "Limit to one county" },
        max_rating: { type: "integer", minimum: 1, maximum: 4, description: "Only places rated this or better (e.g. 2 = Excellent and Good only)" },
        sort: { type: "string", enum: ["best", "worst", "recently_changed", "name"], description: "Order of results (default best). 'recently_changed' = most recent rating changes first." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max results (default 10)" },
        include_closed: { type: "boolean", description: "Also return establishments the county no longer lists (default false)" },
      },
    },
  },
  {
    name: "get_restaurant",
    description:
      "Full record for one establishment by id (from search_restaurants): current rating, latest violations, and up to 20 past inspections with their violations. " +
      "Violation type RED = critical (food-safety risk), BLUE = maintenance/practices.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Establishment id, e.g. 'king:PFE-PR-3144268' or 'sno:FA0001506'" } },
      required: ["id"],
    },
  },
  {
    name: "get_overview",
    description:
      "Dataset totals: establishment counts by county and rating, every valid cuisine key with its count, and the last-refresh timestamp. " +
      "Call this to learn what cuisine values search_restaurants accepts.",
    inputSchema: { type: "object", properties: {} },
  },
];

// mirrors restPath() in index.js (kept local to avoid a circular import for three lines of code)
const slug = (s) => (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)) || "place";
const pageUrl = (r) => "https://food.snoking.app/r/" + r.id.replace(":", ".") + "/" + slug(r.name + "-" + r.city);
const RL = { 1: "Excellent", 2: "Good", 3: "Okay", 4: "Needs to Improve" };

function rowOut(r) {
  const o = {
    id: r.id, name: r.name, address: r.address, city: r.city, county: r.county, cuisine: r.cuisine,
    rating: r.rating, rating_label: RL[r.rating] || "Unrated",
    avg_last5: r.rating_avg, last_inspection: r.inspect_date, page_url: pageUrl(r),
  };
  if (r.prev_rating != null && r.rating_changed_at) { o.previous_rating = r.prev_rating; o.rating_changed = r.rating_changed_at.slice(0, 10); }
  if (r.mobile) o.food_truck = true;    // mobile unit — address/coords are the operator's registered base, not where it vends
  if (r.delisted_at) o.closed = true;   // no longer listed by the county — rating shown is the last one captured
  return o;
}

async function callTool(env, name, a) {
  if (name === "search_restaurants") {
    if (!a.query && !a.city && !a.cuisine && !a.county) throw new Error("give at least one of query, city, cuisine, county");
    const where = [], binds = [];
    if (a.query)   { where.push("name LIKE ?");    binds.push("%" + a.query + "%"); }
    if (a.city)    { where.push("city LIKE ?");    binds.push("%" + a.city + "%"); }
    if (a.cuisine) { where.push("cuisine = ?");    binds.push(String(a.cuisine).toLowerCase()); }
    if (a.county)  { where.push("county = ?");     binds.push(a.county === "king" ? "king" : "snohomish"); }
    if (a.max_rating) { where.push("rating <= ?"); binds.push(a.max_rating); }
    if (!a.include_closed) where.push("delisted_at IS NULL");
    // unrated rows sort last in every mode rather than being filtered out — a name search for a
    // specific place should still find it even if it has no usable rating yet
    const order = a.sort === "worst"            ? "(rating IS NULL), rating DESC, COALESCE(rating_avg, rating) DESC"
                : a.sort === "recently_changed" ? "(rating_changed_at IS NULL), rating_changed_at DESC"
                : a.sort === "name"             ? "name ASC"
                :                                 "(rating IS NULL), rating ASC, COALESCE(rating_avg, rating) ASC";
    const limit = Math.min(50, Math.max(1, a.limit || 10));
    const { results } = await env.DB.prepare(
      `SELECT id,name,address,city,county,cuisine,rating,rating_avg,inspect_date,prev_rating,rating_changed_at,delisted_at,mobile
       FROM establishments WHERE ${where.join(" AND ")} ORDER BY ${order}, name ASC LIMIT ?`
    ).bind(...binds, limit).all();
    return { count: (results || []).length, note: "ratings: 1=Excellent (best) … 4=Needs to Improve (worst)", results: (results || []).map(rowOut) };
  }

  if (name === "get_restaurant") {
    const row = await env.DB.prepare("SELECT * FROM establishments WHERE id = ?").bind(String(a.id || "")).first();
    if (!row) throw new Error("no establishment with id " + a.id + " — ids come from search_restaurants");
    let det = {}; try { det = JSON.parse(row.detail || "{}"); } catch {}
    return {
      ...rowOut(row),
      zip: row.zip, first_seen: row.first_date,
      // avg points per recent routine from food-hazard violations only (temps/hygiene/source/contamination
      // >=10-pt reds + pests) — excludes administrative items like permits and worker cards
      avg_major_violation_points: row.major_pts,
      rating_most_recent_routine: row.rating_routine, rating_worst_ever: row.rating_worst,
      pct_routine_inspections_okay_or_worse: row.poor_frac != null ? Math.round(row.poor_frac * 100) : null,
      county_report_url: row.report_url,
      latest_violations: det.violations || [],
      inspections: (det.history || []).slice(0, 20).map((h) => ({
        date: h.date, result: h.label, points: h.score, service: h.svc, violations: h.v || [],
      })),
    };
  }

  if (name === "get_overview") {
    const [byRating, byCuisine, upd] = await Promise.all([
      env.DB.prepare("SELECT county, rating, COUNT(*) AS n FROM establishments WHERE delisted_at IS NULL GROUP BY county, rating").all(),
      env.DB.prepare("SELECT cuisine, COUNT(*) AS n FROM establishments WHERE delisted_at IS NULL GROUP BY cuisine ORDER BY n DESC").all(),
      env.DB.prepare("SELECT MAX(updated_at) AS u FROM establishments").first(),
    ]);
    const counties = {};
    for (const r of byRating.results || []) {
      const c = (counties[r.county] ||= { total: 0, by_rating: {} });
      c.total += r.n; c.by_rating[r.rating == null ? "unrated" : r.rating] = r.n;
    }
    return {
      rating_scale: RL, counties,
      cuisines: Object.fromEntries((byCuisine.results || []).map((r) => [r.cuisine || "unknown", r.n])),
      data_refreshed: upd?.u || null,
    };
  }

  throw new Error("unknown tool: " + name);
}

const rpc = (id, body) => Response.json({ jsonrpc: "2.0", id, ...body }, { headers: CORS });

export async function handleMcp(req, env) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")
    return new Response("This is an MCP endpoint (Streamable HTTP). Point an MCP client at https://food.snoking.app/mcp — see /about.",
      { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS", "Content-Type": "text/plain" } });

  let msg; try { msg = await req.json(); } catch { return rpc(null, { error: { code: -32700, message: "parse error" } }); }
  if (Array.isArray(msg)) return rpc(null, { error: { code: -32600, message: "batch requests not supported" } });
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return new Response(null, { status: 202, headers: CORS });   // notification — ack, no body

  if (method === "initialize")
    return rpc(id, { result: {
      protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS,
    } });
  if (method === "ping") return rpc(id, { result: {} });
  if (method === "tools/list") return rpc(id, { result: { tools: TOOLS } });
  // not advertised, but some clients probe these anyway — empty lists are friendlier than -32601
  if (method === "resources/list") return rpc(id, { result: { resources: [] } });
  if (method === "prompts/list") return rpc(id, { result: { prompts: [] } });
  if (method === "tools/call") {
    try {
      const out = await callTool(env, params?.name, params?.arguments || {});
      return rpc(id, { result: { content: [{ type: "text", text: JSON.stringify(out) }] } });
    } catch (e) {
      // tool failures are results with isError, not protocol errors — the model is meant to see them
      return rpc(id, { result: { content: [{ type: "text", text: String(e?.message || e) }], isError: true } });
    }
  }
  return rpc(id, { error: { code: -32601, message: "method not found: " + method } });
}
