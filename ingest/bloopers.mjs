// Classify a Snohomish inspector narrative (v_memo) as a "blooper" — a funny/absurd
// note worth surfacing — returning an emoji tag, or null. The food-inspection data has
// nothing grim (no medical/PII like the dispatch feed), so there's no block list; this is
// purely a curated funny-phrase list. First match wins. Tune freely.
const PATS = [
  // absurd excuses & reported speech
  ["went home with", "🏠"], ["took it home", "🏠"], ["took them home", "🏠"], ["made at home", "🏠"], ["from home", "🏠"], ["homemade", "🏠"],
  ["on vacation", "🏖️"], ["no longer works", "🚪"], ["no longer employed", "🚪"], ["doesn't work here", "🚪"], ["does not work here", "🚪"], ["was fired", "🚪"],
  ["couldn't find", "🔍"], ["could not find", "🔍"], ["couldn't locate", "🔍"], ["could not locate", "🔍"], ["unable to locate", "🔍"], ["unable to find", "🔍"],
  ["didn't know", "🤷"], ["did not know", "🤷"], ["wasn't aware", "🤷"], ["was not aware", "🤷"], ["unaware that", "🤷"], ["thought it was", "🤔"], ["thought that", "🤔"],
  ["claimed", "💬"], ["insisted", "💬"], ["refused to", "🙅"],
  // critters
  ["raccoon", "🦝"], ["squirrel", "🐿️"], ["pigeon", "🐦"], [" bird ", "🐦"], ["rooster", "🐓"], ["live chicken", "🐔"], ["rodent", "🐭"], [" mouse", "🐭"], [" mice", "🐭"],
  ["rat dropping", "🐀"], [" rats ", "🐀"], ["cockroach", "🪳"], ["roaches", "🪳"], [" roach", "🪳"], ["maggot", "🐛"], ["gnat", "🦟"], ["fruit fl", "🪰"], [" flies", "🪰"],
  ["dog in", "🐕"], [" a dog", "🐕"], [" a cat", "🐈"], [" pet ", "🐾"],
  // people / behavior
  ["bare hand", "✋"], ["barehand", "✋"], ["bare-hand", "✋"], ["no soap", "🧼"], ["smoking", "🚬"], ["cigarette", "🚬"], ["vaping", "💨"], [" vape", "💨"],
  ["chewing tobacco", "🚬"], ["chewing gum", "😬"], ["licked", "👅"], ["tasting spoon", "👅"], ["double dip", "🥄"], ["spit ", "🤮"], ["sneez", "🤧"],
  ["fingernail", "💅"], ["nail polish", "💅"], ["personal drink", "🥤"], ["personal beverage", "🥤"], ["open drink", "🥤"], ["cell phone", "📱"], ["on their phone", "📱"], ["asleep", "😴"], ["sleeping", "😴"],
  // bizarre storage / place
  ["in the bathroom", "🚽"], ["in the restroom", "🚽"], ["next to the toilet", "🚽"], ["in the car", "🚗"], ["in their car", "🚗"], ["in the trunk", "🚗"],
  ["garden hose", "🚿"], ["gallon bucket", "🪣"], ["in a bucket", "🪣"], ["kiddie pool", "🏊"], ["bathtub", "🛁"], ["milk crate", "📦"], ["under the sink", "🚰"], ["in the closet", "🚪"],
  ["in the garage", "🏚️"], ["duct tape", "🩹"], ["cardboard", "📦"], ["dumpster", "🗑️"], ["back of the truck", "🚚"], ["parking lot", "🅿️"], ["space heater", "🔥"], ["hair dryer", "💨"],
];
export function blooperTag(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  for (const [p, e] of PATS) if (t.includes(p)) return e;
  return null;
}
// pull the human narrative out of a v_memo (drop the WAC legal citation + boilerplate)
export function blooperText(memo) {
  let s = (memo || "").replace(/\r\n?/g, "\n");
  s = s.split(/\(?WAC\s*\d|\(WAC/i)[0];        // cut at the regulation citation
  return s.replace(/\s+/g, " ").replace(/^[-•\s]+/, "").trim();
}

// Generic/food/place words that a name shares with many businesses — never redact these, or
// "pad thai", "the coffee", "gyro meat" etc. would get mangled. Only DISTINCTIVE name tokens
// (the brand word) are stripped, so the blooper reel stays de-identified without losing flavor.
const REDACT_STOP = new Set(("the a an and or of de la el los las inc llc co corp ltd restaurant cafe coffee bar grill grille kitchen market mart deli bakery house cottage stop truck mobile food foods cuisine eatery bistro diner pub tavern lounge express thai pho gyro gyros sushi pizza pizzeria taco tacos taqueria bbq donut donuts bagel bagels chicken seafood noodle noodles ramen teriyaki burger burgers sandwich sandwiches juice tea boba wok asian mexican italian indian korean chinese vietnamese japanese mediterranean american soul country valley village center park lake hill river bay golden royal new old town city east west north south best great little big family fresh garden spice king queen").split(/\s+/));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// strip the establishment's own distinctive name from its blooper narrative (de-identify the reel)
export function redactName(text, name) {
  if (!text || !name) return text;
  let out = text;
  const clean = name.replace(/\([^)]*\)/g, " ").replace(/#\S+/g, " ").replace(/['’]s\b/gi, "");
  const phrase = clean.replace(/\s+/g, " ").trim();
  if (phrase.length >= 6 && /\s/.test(phrase)) out = out.replace(new RegExp(reEsc(phrase), "ig"), "the establishment");
  for (const tok of clean.split(/[^A-Za-z]+/)) {
    if (tok.length >= 4 && !REDACT_STOP.has(tok.toLowerCase()))
      out = out.replace(new RegExp("\\b" + reEsc(tok) + "(?:['’]s)?\\b", "ig"), "the establishment");
  }
  return out.replace(/\s+/g, " ").trim();
}
