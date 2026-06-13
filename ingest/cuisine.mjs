// Infer a coarse type from an establishment name. Name-based heuristic: first
// matching category wins, so order matters — cuisines first (the food type wins
// when present), then non-restaurant venue/service types (school, hotel, catering,
// food truck, senior care, venue/workplace) which only catch names with no cuisine.
const RULES = [
  ["pizza",        ["PIZZA", "PIZZER", "PAPA MURPHY", "DOMINO", "LITTLE CAESAR", "ROUND TABLE", "MOD PIZZA", "PAGLIACCI"]],
  ["mexican",      ["MEXIC", "TAQUER", "TACO", "BURRITO", "TIJUANA", "JALISCO", "CANTINA", "AZTECA", " EL ", " LOS ", " LAS ", "CHIPOTLE", "QDOBA", "GUADALAJARA", "CARNITAS", "TORTA", "BIRRIA", "GORDITO", "OAXACA", "MAZATLAN", "JALAPENO"]],
  ["chinese",      ["CHINA", "CHINESE", "WOK", "PANDA", "SZECHUAN", "SICHUAN", "MANDARIN", "HUNAN", "DIM SUM", "DUMPLING", "BAMBOO", "DRAGON", "HOT POT", "HOTPOT", "PF CHANG", "ORIENT", "CHOP SUEY", "SHANGHAI"]],
  ["teriyaki",     ["TERIYAKI", "TERYAKI", "TERIAKI"]],
  ["japanese",     ["SUSHI", "JAPAN", "RAMEN", "IZAKAYA", "HIBACHI", "SAKE", "UDON", "POKE", "BENTO", "YAKI"]],
  ["thai",         ["THAI", "BANGKOK", "PAD ", "BASIL", "LEMONGRASS", "SIAM"]],
  ["vietnamese",   ["VIET", "PHO ", "PHO", "BANH MI", "SAIGON", "HANOI", "NOODLE"]],
  ["korean",       ["KOREA", "BIBIM", "BULGOGI", "KIMCHI", " BCD ", "SEOUL", "TOFU HOUSE", "DUPBOP"]],
  ["indian",       ["INDIA", "INDIAN", "CURRY", "TANDOOR", "MASALA", "BIRYANI", "PUNJAB", "HIMALAY", "NAAN", "BOMBAY"]],
  ["mediterranean",["GREEK", "GYRO", "MEDITERR", "KABOB", "KEBAB", "FALAFEL", "SHAWARMA", "HUMMUS", " PITA", "PITA ", "LEBAN", "PERSIAN", "HALAL", "AFGHAN", "KABUL", "CEDAR"]],
  ["italian",      ["ITALI", "PASTA", "TRATTORIA", "RISTORANTE", "OLIVE GARDEN", "SPAGHET", "LASAGN"]],
  ["bbq",          ["BBQ", "BARBEQUE", "BARBECUE", "SMOKEHOUSE", "SMOKE HOUSE", "BRISKET", "RIB "]],
  ["burgers",      ["BURGER", "MCDONALD", "WENDY", "BURGER KING", "FIVE GUYS", "IN-N-OUT", "SHAKE SHACK", "WHATABURGER", "DICK'S DRIVE", "FATBURGER", "HABIT"]],
  ["chicken",      ["CHICKEN", "KFC", "POPEYE", "CHICK-FIL", "WINGS", "WINGSTOP", "FRIED CHICK"]],
  ["sandwich",     ["SUBWAY", "JIMMY JOHN", "JERSEY MIKE", "QUIZNOS", "SANDWICH", " DELI", "DELI ", "DELICATESSEN", "BLIMPIE", "TOGO", "POTBELLY", "PANERA"]],
  ["seafood",      ["SEAFOOD", "FISH", "CRAB", "OYSTER", "IVAR", "SHRIMP", "LOBSTER", "CHOWDER"]],
  ["coffee",       ["COFFEE", "STARBUCK", "ESPRESSO", "CAFE", "CAFÉ", "CAFFE", "DUTCH BROS", "TULLY", "PEET", "ROASTER", " TEA ", "BOBA", "BUBBLE TEA", "JAVA", "LATTE", "SMOOTHIE", "JUICE", "BARISTA"]],
  ["bakery",       ["BAKERY", "BAKE", "DONUT", "DOUGHNUT", "PASTR", "DESSERT", "ICE CREAM", "FROZEN YOGURT", "GELATO", "CREAMERY", "CUPCAKE", "SWEET", "CANDY", "CHOCOLAT", "BASKIN", "DAIRY QUEEN", "COLD STONE", "MENCHIE", "BAGEL"]],
  ["bar",          [" BAR ", " BAR", " PUB", "TAVERN", "BREWING", "BREWERY", "BREWPUB", "TAPHOUSE", "TAP HOUSE", "TAP ROOM", "TAPROOM", "ALEHOUSE", "SALOON", "LOUNGE", "SPORTS BAR", "WINE", "DISTILL", "CELLAR", "WINERY", "VINEYARD", "CIDER", "MEADERY", "HOP SHOP"]],
  ["grocery",      ["MARKET", "GROCERY", "SAFEWAY", "FRED MEYER", "QFC", "ALBERTSON", "WALMART", "COSTCO", "TARGET", "WINCO", "TRADER JOE", "WHOLE FOODS", "GROCER", "MINI MART", "MINIMART", "FOOD MART", " MART ", "7-ELEVEN", "CIRCLE K", "CHEVRON", "SHELL", " 76 ", "AM/PM", "AMPM", "SUPERMARK", "MERCADO", "CARNICER", "WALGREEN", "RITE AID", " CVS ", "PHARMACY", "DOLLAR TREE", "DOLLAR GENERAL", "FAMILY DOLLAR", "ARCO", "JACKSON", "CONVENIENCE", "FUEL"]],
  ["fastfood",     ["TACO BELL", "JACK IN THE BOX", "DEL TACO", "ARBY", "SONIC", "CARL'S JR", "CARLS JR", "HARDEE", "A&W", "DENNY", "IHOP"]],
  ["cafe_diner",   ["DINER", "FAMILY RESTAURANT", "PANCAKE", "BREAKFAST", "BRUNCH", "WAFFLE"]],
  // ---- non-restaurant food-service venue types (only reached when no cuisine matched) ----
  ["school",       ["SCHOOL", "ELEMENTARY", " HIGH ", " MIDDLE ", "ACADEMY", "COLLEGE", "UNIVERSIT", "CAMPUS", "PRESCHOOL", "MONTESSORI", "HEAD START", "KINDER", "DAYCARE", "CHILD CARE", "LEARNING CENTER", "EDUCATION", " ISD ", "FRATERNITY", "SORORITY"]],
  ["seniorcare",   ["SENIOR", "ASSISTED LIVING", "RETIREMENT", "NURSING", "REHAB", " CARE ", "CARE CENTER", "HOSPITAL", "MEDICAL CENTER", "HEALTH CENTER", "MEMORY CARE", " LIVING "]],
  ["hotel",        ["HOTEL", "MOTEL", "SUITES", "MARRIOTT", "HILTON", "HYATT", "SHERATON", "WESTIN", "RESIDENCE INN", "HOLIDAY INN", "COMFORT INN", "DAYS INN", "HAMPTON", "COURTYARD", "DOUBLETREE", "RAMADA", "LA QUINTA", "BEST WESTERN", "RED LION", "EMBASSY SUITES", "FAIRFIELD", "TRAVELODGE", "MOTEL 6", " RESORT", "LODGE ", " INN "]],
  ["catering",     ["CATERING", "CATERER", "BANQUET", "COMMISSARY"]],
  ["foodtruck",    [" MOBILE", " TRUCK", "FOOD TRUCK", "FOOD CART", "CONCESSION", "VENDING"]],
  ["venue",        ["LEVY", "CANTEEN", "ARAMARK", "BON APPETIT", "COMPASS GROUP", "GUCKENHEIM", "ARENA", "STADIUM", " FIELD", "CLUBHOUSE", "GOLF", "COUNTRY CLUB", "BOWL", "CASINO", "THEATER", "THEATRE", "CINEMA", "MUSEUM", " ZOO ", "LUMEN", "CLUB ", "SR CENTER", "COMMUNITY CENTER", "REC CENTER", "FAIRGROUND", "RACEWAY", "SPEEDWAY"]],
];
export function cuisineOf(name) {
  const n = " " + (name || "").toUpperCase() + " ";
  for (const [slug, kws] of RULES) for (const k of kws) if (n.includes(k)) return slug;
  return "other";
}
export const CUISINE_LABELS = {
  pizza: "Pizza", mexican: "Mexican", chinese: "Chinese", japanese: "Japanese / Sushi",
  teriyaki: "Teriyaki", thai: "Thai", vietnamese: "Vietnamese", korean: "Korean", indian: "Indian",
  mediterranean: "Mediterranean", italian: "Italian", bbq: "BBQ", burgers: "Burgers",
  chicken: "Chicken", sandwich: "Sandwich / Deli", seafood: "Seafood", coffee: "Coffee / Tea",
  bakery: "Bakery / Dessert", bar: "Bar / Pub", grocery: "Grocery / Market",
  fastfood: "Fast Food", cafe_diner: "Cafe / Diner",
  school: "School / Education", seniorcare: "Senior / Care", hotel: "Hotel / Lodging",
  catering: "Catering", foodtruck: "Food Truck / Mobile", venue: "Venue / Workplace",
  other: "Other",   // "workplace" merged into "venue"
};
