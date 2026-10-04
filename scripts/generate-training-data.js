#!/usr/bin/env node
/**
 * Generate synthetic transaction training data for fine-tuning a classifier (v2).
 *
 * Produces [debit]/[credit] prefixed description + category pairs that mimic
 * real US bank statement formats. Sign prefixes reflect real-world direction:
 * spending categories are mostly debits, Income is almost always credit,
 * Transfer is bidirectional.
 *
 * v2 changes: sign prefixes; Housing split into Mortgage + Rent (17 categories).
 * v2.1 changes: abbreviated merchant forms, marketplace patterns, compressed chain names.
 *
 * This is the generator behind the published HuggingFace dataset
 * DoDataThings/us-bank-transaction-categories-v2 (68,000 rows = 17 categories
 * x 4,000, produced with --count 4000). Output is random (no seed), so a new
 * run is a fresh sample from the same distribution, not a copy.
 * Anonymized — no real account numbers, names, or identifying info.
 *
 * Usage:
 *   node scripts/generate-training-data.js
 *   node scripts/generate-training-data.js --count 4000  # per category (published dataset)
 *
 * Output: data/training/transactions-synthetic.csv
 */

const fs = require('fs');
const path = require('path');

const countArg = process.argv.includes('--count')
  ? parseInt(process.argv[process.argv.indexOf('--count') + 1])
  : 4000;

// === MERCHANT POOLS ===

const merchants = {
  restaurants: {
    fastFood: [
      "MCDONALD'S", "CHICK-FIL-A", "TACO BELL", "WENDY'S", "BURGER KING",
      "POPEYES", "JACK IN THE BOX", "IN-N-OUT", "FIVE GUYS", "SONIC",
      "WHATABURGER", "CARL'S JR", "HARDEE'S", "ARBY'S", "PANDA EXPRESS",
      "CHIPOTLE", "QDOBA", "MOE'S", "WINGSTOP", "RAISING CANE'S",
      "JOLLIBEE", "EL POLLO LOCO", "DEL TACO", "RALLY'S", "CHECKERS",
      "THE HABIT BURGER", "HABIT BURGER", "SHAKE SHACK", "SMASHBURGER",
      "FATBURGER", "FREDDY'S", "CULVER'S", "STEAK N SHAKE",
      "COOK OUT", "PORTILLO'S", "KRISPY KREME", "DUNKIN DONUTS",
    ],
    sitDown: [
      "OLIVE GARDEN", "APPLEBEE'S", "CHILI'S", "OUTBACK STEAKHOUSE", "RED LOBSTER",
      "TEXAS ROADHOUSE", "DENNY'S", "IHOP", "CRACKER BARREL", "CHEESECAKE FACTORY",
      "P.F. CHANG'S", "RUTH'S CHRIS", "RED ROBIN", "BUFFALO WILD WINGS", "TGI FRIDAY'S",
    ],
    coffee: [
      "STARBUCKS", "DUNKIN", "PEET'S COFFEE", "DUTCH BROS", "CARIBOU COFFEE",
      "TIM HORTONS", "BLUE BOTTLE", "PHILZ COFFEE", "INTELLIGENTSIA",
    ],
    delivery: [
      "DOORDASH", "UBER EATS", "GRUBHUB", "POSTMATES", "INSTACART",
    ],
    local: [
      "GOLDEN DRAGON", "SAKURA SUSHI", "TAQUERIA EL BUEN GUSTO", "PHO SAIGON",
      "THAI BASIL", "BOMBAY SPICE", "LUIGI'S PIZZA", "NANDO'S", "SHAWARMA KING",
      "SEOUL GARDEN", "DIM SUM KING", "RAMEN HOUSE", "TACOS EL GORDO",
      "MING'S KITCHEN", "CURRY HOUSE", "KEBAB PALACE", "POKE BOWL",
      "BOBA TEA HOUSE", "SUSHI SPOT", "WOK EXPRESS", "PANDA GARDEN",
      "SHENG KEE BAKERY", "MASTER SHIN", "MOCHINUT", "SAN PEDRO MARKET",
      "HORATIO'S", "TAISHOKEN RAMEN", "PHO 99", "ONO HAWAIIAN BBQ",
      "GEN KOREAN BBQ", "DAVE'S HOT CHICKEN", "SOMISOMI", "TOO GOOD TO GO",
      "DIN TAI FUNG", "HAIDILAO", "SZECHUAN PALACE", "HUNAN GARDEN",
      "PEKING DUCK HOUSE", "GREAT WALL", "CHINA WOK", "WOK N ROLL",
      "KURA SUSHI", "MARUGAME UDON", "ICHIRAN RAMEN", "IPPUDO",
      "BONCHON", "KBBQ HOUSE", "TOFU HOUSE", "JOLLIBEE",
      "BANH MI", "SHARETEA", "KUNG FU TEA", "TIGER SUGAR",
      "TACO CABANA", "EL TORITO", "CASA OLE", "MI PUEBLO",
      "NAAN N CURRY", "TIKKA MASALA", "HIMALAYAN KITCHEN",
      "ETHIOPIAN RESTAURANT", "JERK CHICKEN", "ISLAND GRILL",
      "GYRO KING", "FALAFEL DRIVE-IN", "MEDITERRANEAN GRILL",
    ],
  },
  groceries: {
    chains: [
      "WHOLE FOODS", "TRADER JOE'S", "SAFEWAY", "KROGER", "PUBLIX",
      "ALDI", "SPROUTS", "H-E-B", "WEGMANS", "FOOD LION",
      "GIANT EAGLE", "MEIJER", "PIGGLY WIGGLY", "WINN-DIXIE", "LUCKY",
      "STOP & SHOP", "SHAW'S", "ALBERTSONS", "RALPH'S", "VONS",
      "FOOD 4 LESS", "GROCERY OUTLET", "MARKET BASKET", "HARRIS TEETER",
      "99 RANCH", "H MART", "MITSUWA", "RANCH 99", "MARUKAI",
      "FOODMAXX", "WINCO FOODS", "NATURAL GROCERS", "FRESH MARKET",
      "SAVEMART", "SMART AND FINAL", "CARDENAS", "NORTHGATE MARKET",
      "ASIAN SUPERMARKET", "LION SUPERMARKET", "SEAFOOD CITY",
      "365 MARKET",
    ],
    warehouse: [
      "COSTCO WHSE", "SAM'S CLUB", "BJ'S WHOLESALE",
    ],
  },
  shopping: {
    online: [
      "AMAZON", "EBAY", "ETSY", "WAYFAIR", "WISH.COM",
      "SHEIN", "TEMU", "ALIEXPRESS", "ZAPPOS", "CHEWY",
      "OVERSTOCK", "ZARA", "H&M", "ASOS", "NIKE.COM",
      "ADIDAS.COM", "UNIQLO", "GAP.COM", "OLD NAVY",
      "NEWEGG", "CENTRAL COMPUTERS", "TIKTOK SHOP",
      "FACEBOOK MARKETPLACE", "MERCARI", "OFFERUP",
      "REPAIRCLINIC.COM", "PARTSELECT", "IFIXIT",
      "LIFETOUCH", "SHUTTERFLY", "SNAPFISH",
      "CORPORATE FILINGS", "LEGALZOOM", "INCFILE", "NORTHWEST REGISTERED AGENT",
    ],
    retail: [
      "TARGET", "WALMART", "BEST BUY", "HOME DEPOT", "LOWE'S",
      "BED BATH & BEYOND", "IKEA", "MARSHALLS", "TJ MAXX", "ROSS",
      "DOLLAR TREE", "DOLLAR GENERAL", "FIVE BELOW", "MICHAELS", "HOBBY LOBBY",
      "BATH & BODY WORKS", "CRATE & BARREL", "POTTERY BARN", "WILLIAMS SONOMA",
      "COSTCO", "WALGREENS", "CVS", "RITE AID", "7-ELEVEN",
      "PIER 1", "WORLD MARKET", "BIG LOTS", "TUESDAY MORNING",
      "BANANA REPUBLIC", "J.CREW", "ANTHROPOLOGIE", "LULULEMON",
      "ATHLETA", "ANN TAYLOR", "EXPRESS", "AMERICAN EAGLE",
      "HOLLISTER", "ABERCROMBIE", "FOREVER 21", "PRIMARK",
      "COSTCO ONLINE", "SAMS CLUB ONLINE",
    ],
    department: [
      "MACY'S", "NORDSTROM", "JC PENNEY", "KOHL'S", "DILLARD'S",
      "SAKS", "NEIMAN MARCUS", "BLOOMINGDALE'S", "BURLINGTON",
      "ROSS DRESS FOR LESS", "CENTURY 21",
    ],
    electronics: [
      "APPLE STORE", "SAMSUNG", "MICRO CENTER", "B&H PHOTO", "GAMESTOP",
      "DELL", "HP STORE", "LENOVO",
    ],
    pet: [
      "PETSMART", "PETCO", "PET SUPPLIES PLUS",
      "PETPEOPLE", "HEALTHY PET",
    ],
    dtc: [
      "CASPER", "AWAY", "ALLBIRDS",
      "BOMBAS", "GLOSSIER", "EVERLANE",
    ],
    resale: [
      "THREDUP", "POSHMARK", "GOODWILL", "SALVATION ARMY",
      "SAVERS", "BUFFALO EXCHANGE",
    ],
    liquor: [
      "TOTAL WINE", "BEV MO", "BEVMO", "SPEC'S", "ABC FINE WINE",
      "TWIN LIQUORS", "BINNY'S", "LIQUOR BARN", "LIQUOR STORE",
      "WINE.COM", "DRIZLY",
    ],
    office: [
      "STAPLES", "OFFICE DEPOT", "FEDEX OFFICE", "UPS STORE",
      "VISTAPRINT", "MOO.COM", "GODADDY", "NAMECHEAP", "NAME.COM",
      "SQUARESPACE", "WORDPRESS.COM", "WIX", "SHOPIFY",
    ],
  },
  transportation: {
    gas: [
      "CHEVRON", "SHELL", "BP", "ARCO", "76", "EXXON", "MOBIL",
      "VALERO", "MARATHON", "SUNOCO", "CITGO", "PHILLIPS 66",
      "SPEEDWAY", "QUIKTRIP", "WAWA", "SHEETZ", "CASEY'S",
      "COSTCO GAS",
    ],
    rideshare: ["UBER", "LYFT"],
    auto: [
      "AUTOZONE", "O'REILLY AUTO", "ADVANCE AUTO", "NAPA AUTO",
      "JIFFY LUBE", "MIDAS", "FIRESTONE", "GOODYEAR", "DISCOUNT TIRE",
      "SAFELITE", "MAACO", "OIL CHANGERS", "QUICK SMOG", "SMOG CHECK",
      "SMOG STATION", "AMERICAS TIRE",
    ],
    parking: [
      "PARKWHIZ", "SPOTHERO", "PARKME", "CITY PARKING", "LAZ PARKING",
      "ACE PARKING", "SP PLUS", "PARKSMART",
    ],
    transit: [
      "MTA", "BART", "CALTRAIN", "WMATA", "CTA",
    ],
    ev: [
      "CHARGEPOINT", "ELECTRIFY AMERICA", "TESLA SUPERCHARGER", "BLINK CHARGING",
      "EVGO", "VOLTA CHARGING", "SEMACONNECT",
    ],
    tolls: [
      "E-ZPASS", "FASTRAK", "SUNPASS", "TXTAG", "PIKEPASS",
      "PEACH PASS", "GOOD TO GO", "I-PASS",
    ],
    carwash: [
      "MISTER CAR WASH", "TAKE 5 CAR WASH", "ZIPS CAR WASH",
      "TOMMY'S EXPRESS", "QUICK QUACK",
    ],
    dmv: [
      "CA DMV", "DMV REGISTRATION", "DEPT OF MOTOR VEHICLES",
      "STATE DMV", "VEHICLE REGISTRATION",
    ],
  },
  entertainment: {
    events: [
      "TICKETMASTER", "STUBHUB", "AXSTICKETS", "LIVENATION", "FANDANGO",
      "AMC THEATRES", "REGAL CINEMAS", "CINEMARK", "IMAX",
    ],
    gaming: [
      "STEAM", "PLAYSTATION", "XBOX", "NINTENDO", "EPIC GAMES",
      "ROBLOX", "RIOT GAMES", "BLIZZARD", "EA GAMES", "SQUARE ENIX",
      "BUNGIE", "UBISOFT", "ACTIVISION", "VALVE", "VALVE CORP",
    ],
    gambling: [
      "DRAFTKINGS", "FANDUEL", "BETMGM", "CAESARS SPORTSBOOK",
      "POINTSBET", "HARD ROCK BET", "BARSTOOL SPORTSBOOK",
      "BOVADA", "MYBOOKIE", "BETRIVERS",
      "MGM GRAND", "BELLAGIO", "WYNN", "ENCORE", "HARRAH'S",
      "HORSESHOE CASINO", "MOHEGAN SUN", "FOXWOODS",
    ],
    other: [
      "DAVE & BUSTER'S", "TOPGOLF", "BOWLING", "ESCAPE ROOM",
      "MUSEUM", "ZOO", "AQUARIUM", "THEME PARK",
    ],
    sports: [
      "ESPN+", "FUBOTV", "DAZN", "NBA LEAGUE PASS",
      "NFL SUNDAY TICKET", "MLB.TV",
    ],
    recreation: [
      "CLIMBING GYM", "TRAMPOLINE PARK", "GO KART",
      "LASER TAG", "SKATING RINK", "SWIMMING POOL",
      "GOLF COURSE", "DRIVING RANGE", "MINI GOLF",
    ],
  },
  utilities: {
    electric: [
      "PG&E", "PGANDE", "PG AND E", "CONED", "DUKE ENERGY", "SOUTHERN CALIFORNIA EDISON",
      "FLORIDA POWER", "DOMINION ENERGY", "XCEL ENERGY", "AES",
      "NATIONAL GRID", "ENTERGY", "EVERSOURCE",
    ],
    internet: [
      "COMCAST", "XFINITY", "AT&T", "VERIZON", "T-MOBILE",
      "SPECTRUM", "COX", "CENTURYLINK", "FRONTIER", "OPTIMUM",
      "GOOGLE FIBER", "STARLINK",
    ],
    water: [
      "WATER UTILITY", "CITY WATER", "MUNICIPAL WATER",
      "AMERICAN WATER", "AQUA AMERICA",
    ],
    phone: [
      "VISIBLE", "MINT MOBILE", "CRICKET", "BOOST MOBILE",
      "METRO BY T-MOBILE", "US MOBILE", "TING",
    ],
    waste: [
      "REPUBLIC SERVICES", "WASTE MANAGEMENT", "WASTE CONNECTIONS",
      "CASELLA WASTE", "GFL ENVIRONMENTAL", "RECOLOGY",
    ],
    solar: [
      "SUNRUN", "SUNPOWER", "TESLA ENERGY", "VIVINT SOLAR",
    ],
  },
  subscription: {
    streaming: [
      "NETFLIX", "SPOTIFY", "HULU", "DISNEY+", "HBO MAX",
      "PARAMOUNT+", "PEACOCK", "APPLE TV+", "YOUTUBE PREMIUM",
      "AMAZON PRIME", "AUDIBLE", "CRUNCHYROLL", "TUBI",
    ],
    software: [
      "ADOBE", "MICROSOFT 365", "GOOGLE ONE", "DROPBOX", "EVERNOTE",
      "NOTION", "CANVA", "GRAMMARLY", "LASTPASS", "1PASSWORD",
      "DASHLANE", "NORDVPN", "EXPRESSVPN", "CHATGPT PLUS",
    ],
    news: [
      "NEW YORK TIMES", "WASHINGTON POST", "WALL STREET JOURNAL",
      "MEDIUM.COM", "SUBSTACK", "THE ATHLETIC", "BLOOMBERG",
    ],
    fitness: [
      "PELOTON", "FITBIT PREMIUM", "STRAVA", "MYFITNESSPAL",
      "HEADSPACE", "CALM",
    ],
    other: [
      "TRADINGVIEW", "EXPERIAN", "CREDIT KARMA",
      "ANCESTRY.COM", "23ANDME", "DUOLINGO",
    ],
    saas: [
      "AMAZON WEB SERVICES", "GOOGLE CLOUD", "MICROSOFT AZURE",
      "HEROKU", "VERCEL", "NETLIFY", "RENDER.COM", "DIGITALOCEAN",
      "LINODE", "VULTR", "CLOUDFLARE", "FASTLY",
      "GITHUB", "GITLAB", "BITBUCKET", "JIRA", "CONFLUENCE",
      "FIGMA", "SKETCH", "INVISION", "MIRO", "NOTION",
      "OPENAI", "ANTHROPIC", "MIDJOURNEY", "STABILITY AI", "RUNWAY",
      "REPLICATE", "HUGGING FACE", "CURSOR", "COPILOT", "PERPLEXITY AI",
      "RAPIDAPI", "POSTMAN", "TWILIO", "SENDGRID", "SUPABASE", "NEON",
      "FASTSPRING", "PADDLE", "PADDLE.NET", "GUMROAD",
      "LEMONSQUEEZY", "STRIPE BILLING",
      "PRIVATE INTERNET ACCESS", "SURFSHARK",
      "PROTONVPN", "MULLVAD",
      "OBSIDIAN", "OBSIDIAN.MD",
      "FINVIZ", "FINANCIAL MODELING PREP", "ASSEMBLYAI", "SUNO",
      "POLYGON.IO", "ALPHA VANTAGE",
    ],
    social: [
      "X PREMIUM", "X CORP", "X CORP. PAID FEATURES", "TWITTER BLUE",
      "REDDIT PREMIUM", "DISCORD NITRO",
      "TELEGRAM PREMIUM", "SNAPCHAT+", "TIKTOK",
      "META VERIFIED", "INSTAGRAM", "FACEBOOK GAMING",
      "YOUTUBE PREMIUM", "TWITCH",
      "LINKEDIN PREMIUM", "LINKEDIN LEARNING",
      "PATREON", "SUBSTACK", "KO-FI",
    ],
    dating: [
      "TINDER", "HINGE", "BUMBLE", "MATCH.COM", "EHARMONY",
      "COFFEE MEETS BAGEL", "OKCUPID",
    ],
    business: [
      "SALESFORCE", "HUBSPOT", "ZENDESK", "FRESHDESK",
      "ZOHO", "MONDAY.COM", "ASANA", "CLICKUP",
      "DOCUSIGN", "CALENDLY", "LOOM", "ZAPIER",
      "AIRTABLE", "SMARTSHEET", "BASECAMP",
    ],
  },
  healthcare: {
    pharmacy: ["CVS", "WALGREENS", "RITE AID", "COSTCO PHARMACY", "WALMART PHARMACY"],
    provider: [
      "DR. SMITH FAMILY MEDICINE", "DENTAL ASSOCIATES", "VISION CENTER",
      "PHYSICAL THERAPY", "URGENT CARE", "QUEST DIAGNOSTICS", "LABCORP",
      "KAISER PERMANENTE", "SUTTER HEALTH", "ONE MEDICAL",
    ],
    mental: ["BETTERHELP", "TALKSPACE", "CEREBRAL"],
    telehealth: [
      "TELADOC", "MDLIVE", "AMWELL", "PLUSHCARE", "DOCTOR ON DEMAND",
      "SESAME CARE", "CEREBRAL", "DONE HEALTH",
    ],
    dental: [
      "ASPEN DENTAL", "HEARTLAND DENTAL", "PACIFIC DENTAL", "WESTERN DENTAL",
      "GENTLE DENTAL", "COMFORT DENTAL", "DENTAL365",
    ],
    vision: [
      "LENSCRAFTERS", "WARBY PARKER", "VISIONWORKS", "AMERICAS BEST",
      "PEARLE VISION", "1-800-CONTACTS", "ZENNI OPTICAL",
    ],
    hospital: [
      "KAISER PERMANENTE", "HCA HEALTHCARE", "SUTTER HEALTH",
      "PROVIDENCE HEALTH", "DIGNITY HEALTH", "INTERMOUNTAIN",
      "MAYO CLINIC", "CLEVELAND CLINIC",
    ],
  },
  insurance: {
    auto: [
      "FARMERS INS", "STATE FARM", "GEICO", "PROGRESSIVE", "ALLSTATE",
      "USAA", "LIBERTY MUTUAL", "NATIONWIDE", "TRAVELERS", "ERIE INSURANCE",
      "AMERICAN FAMILY", "HARTFORD",
    ],
    home: ["LEMONADE", "HIPPO", "HOMESITE", "HOMESERVE", "HOME WARRANTY", "AMERICAN HOME SHIELD", "CHOICE HOME WARRANTY"],
    life: [
      "HAVEN LIFE", "LADDER", "BESTOW", "PRUDENTIAL",
      "TRANSAMERICA", "METLIFE", "NEW YORK LIFE", "NORTHWESTERN MUTUAL",
      "LINCOLN FINANCIAL", "MASS MUTUAL", "PACIFIC LIFE", "AFLAC",
    ],
    health: ["BLUE CROSS", "AETNA", "CIGNA", "UNITED HEALTHCARE", "HUMANA", "ANTHEM"],
  },
  mortgage: {
    banks: [
      "WELLS FARGO MORTGAGE", "CHASE MORTGAGE", "BANK OF AMERICA MORTGAGE",
      "US BANK MORTGAGE", "NATIONSTAR", "PENNYMAC", "FREEDOM MORTGAGE",
      "LOANCARE", "MR. COOPER", "ROCKET MORTGAGE", "NEWREZ", "PHH MORTGAGE",
      "CALIBER HOME LOANS", "GUILD MORTGAGE", "FLAGSTAR BANK",
      "NAVY FEDERAL CU", "PENFED CU", "ALLIANT CU", "BETHPAGE FCU",
      "GOLDEN 1 CU", "SCHOOLSFIRST FCU", "PATELCO CU", "BECU",
      "SOFI MORTGAGE", "BETTER MORTGAGE", "GUARANTEED RATE",
      "LOANDEPOT", "UNITED WHOLESALE", "MOVEMENT MORTGAGE",
    ],
  },
  rent: {
    propertyMgmt: [
      "EQUITY RESIDENTIAL", "AVALON COMMUNITIES", "GREYSTAR",
      "CAMDEN PROPERTY", "ESSEX PROPERTY", "INVITATION HOMES",
      "IRVINE COMPANY", "RELATED COS", "BROOKFIELD",
      "LINCOLN PROPERTY", "JBG SMITH", "BOZZUTO",
      "MAA", "UDR INC", "AIMCO", "NHP FOUNDATION",
    ],
  },
  travel: {
    hotels: [
      "MARRIOTT", "HILTON", "HOLIDAY INN", "HYATT", "BEST WESTERN",
      "WYNDHAM", "RADISSON", "DOUBLETREE", "COURTYARD", "HAMPTON INN",
      "AIRBNB", "VRBO",
    ],
    airlines: [
      "UNITED AIRLINES", "DELTA AIR LINES", "SOUTHWEST AIRLINES", "AMERICAN AIRLINES",
      "JETBLUE", "ALASKA AIRLINES", "SPIRIT AIRLINES", "FRONTIER AIRLINES",
    ],
    booking: [
      "EXPEDIA", "BOOKING.COM", "KAYAK", "PRICELINE", "HOTWIRE",
      "TRIPADVISOR", "TRAVELOCITY",
    ],
    rental: [
      "HERTZ", "ENTERPRISE", "AVIS", "BUDGET", "NATIONAL CAR RENTAL",
      "DOLLAR RENT A CAR", "TURO",
    ],
    cruise: [
      "ROYAL CARIBBEAN", "CARNIVAL CRUISE", "NORWEGIAN CRUISE",
      "DISNEY CRUISE", "MSC CRUISES", "PRINCESS CRUISES",
    ],
    airport: [
      "TSA PRECHECK", "GLOBAL ENTRY", "CLEAR", "AIRPORT PARKING",
      "PRIORITY PASS", "CENTURION LOUNGE",
    ],
  },
  education: {
    online: [
      "COURSERA", "UDEMY", "SKILLSHARE", "MASTERCLASS",
      "CODECADEMY", "DATACAMP", "BRILLIANT.ORG", "KHAN ACADEMY",
    ],
    books: [
      "BARNES & NOBLE", "CHEGG", "AMAZON KINDLE", "PACKT PUBLISHING",
      "O'REILLY MEDIA", "PEARSON", "MCGRAW HILL",
    ],
    tuition: [
      "UNIVERSITY", "COLLEGE", "COMMUNITY COLLEGE", "SCHOOL DISTRICT",
    ],
    tutoring: [
      "WYZANT", "VARSITY TUTORS", "KUMON", "SYLVAN LEARNING",
      "MATHNASIUM", "HUNTINGTON LEARNING",
    ],
    certification: [
      "PLURALSIGHT", "BRILLIANT.ORG",
    ],
  },
  personalCare: {
    salon: [
      "SUPERCUTS", "GREAT CLIPS", "SPORTS CLIPS", "ULTA SALON",
      "FANTASTIC SAMS", "COST CUTTERS",
    ],
    beauty: [
      "SEPHORA", "ULTA BEAUTY", "MAC COSMETICS", "BATH & BODY WORKS",
      "SALLY BEAUTY",
    ],
    gym: [
      "PLANET FITNESS", "24 HOUR FITNESS", "LA FITNESS", "EQUINOX",
      "ANYTIME FITNESS", "GOLD'S GYM", "ORANGETHEORY", "CROSSFIT",
      "YMCA", "CRUNCH FITNESS",
    ],
    spa: [
      "MASSAGE ENVY", "HAND & STONE", "ELEMENTS MASSAGE",
    ],
    barber: [
      "SPORT CLIPS", "FLOYD'S 99",
      "BISHOPS CUT", "ROOSTERS",
    ],
    skincare: [
      "THE ORDINARY", "CERAVE",
      "DERMALOGICA", "BLUEMERCURY",
    ],
  },
  // Business merchants redistributed to Subscription (SaaS) and Shopping (office/domain)
  // These are now part of the subscription and shopping pools below
  transfer: {
    p2p: ["ZELLE", "VENMO", "CASH APP", "PAYPAL"],
    ccPayment: [
      "CHASE CREDIT CRD AUTOPAY", "CAPITAL ONE AUTOPAY", "DISCOVER AUTOPAY",
      "CITI AUTOPAY", "AMEX AUTOPAY", "BARCLAYCARD", "SYNCHRONY",
      "APPLECARD GSBANK PAYMENT",
    ],
    bank: [
      "WELLS FARGO", "BANK OF AMERICA", "JPMORGAN CHASE", "US BANK",
      "PNC BANK", "TD BANK", "FIFTH THIRD", "REGIONS BANK",
    ],
    brokerage: [
      "SCHWAB", "FIDELITY", "VANGUARD", "TD AMERITRADE", "E*TRADE",
      "ROBINHOOD", "WEBULL", "INTERACTIVE BROKERS", "MERRILL LYNCH",
      "MORGAN STANLEY", "CHARLES SCHWAB", "NINJATRADER", "THINKORSWIM",
      "TASTYTRADE", "TRADESTATION", "TRADIER", "FIRSTRADE",
      "COINBASE", "GEMINI", "KRAKEN", "BINANCE.US", "CRYPTO.COM",
      "BITSTAMP", "UPHOLD", "STRIKE",
    ],
    bnpl: [
      "AFFIRM", "KLARNA", "AFTERPAY", "SEZZLE", "ZIP PAY",
      "SPLITIT", "QUADPAY",
    ],
    fintech: [
      "MERCURY", "CHIME", "RELAY", "BREX", "BLUEVINE",
      "NOVO", "ARC", "FOUND", "LILI", "RHO",
      "MEOW", "NEARSIDE", "GRASSHOPPER",
      "DUB", "DUB (ECFI)",
    ],
  },
  income: {
    employers: [
      "ADP", "PAYCHEX", "GUSTO", "INTUIT PAYROLL", "WORKDAY",
    ],
    banks: [
      "INTEREST PAYMENT", "MONTHLY INTEREST PAID", "DIVIDEND",
      "STATEMENT CREDIT", "CASH BACK REWARD",
    ],
    government: [
      "SSA TREAS", "IRS TREAS", "US TREASURY", "STATE COMPTROLLER",
      "UNEMPLOYMENT INS", "VA BENEFITS", "CHILD TAX CREDIT",
    ],
    gig: [
      "UBER", "LYFT", "DOORDASH", "INSTACART", "GRUBHUB",
      "FIVERR", "UPWORK", "TOPTAL", "ETSY", "EBAY",
    ],
  },
  fees: {
    types: [
      "OVERDRAFT FEE", "MONTHLY SERVICE FEE", "ATM FEE", "ATM SURCHARGE",
      "ATM OPERATOR FEE", "NON-NETWORK ATM FEE", "ATM SERVICE CHARGE",
      "WIRE TRANSFER FEE",
      "LATE PAYMENT FEE", "RETURNED ITEM FEE", "FOREIGN TRANSACTION FEE",
      "ANNUAL FEE", "CASH ADVANCE FEE", "BALANCE TRANSFER FEE",
      "DAILY CASH ADJUSTMENT",
      "ACCOUNT MAINTENANCE FEE", "PAPER STATEMENT FEE", "INSUFFICIENT FUNDS FEE",
      "STOP PAYMENT FEE", "ACCOUNT CLOSURE FEE", "CARD REPLACEMENT FEE",
      "EXPEDITED SHIPPING FEE", "INTERNATIONAL WIRE FEE", "ACH RETURN FEE",
      "INACTIVITY FEE", "MINIMUM BALANCE FEE", "EXCESS TRANSACTION FEE",
    ],
  },
};

// === HELPERS ===

const US_CITIES = [
  ["SAN FRANCISCO", "CA", "94102"], ["LOS ANGELES", "CA", "90001"], ["NEW YORK", "NY", "10001"],
  ["CHICAGO", "IL", "60601"], ["HOUSTON", "TX", "77001"], ["PHOENIX", "AZ", "85001"],
  ["SEATTLE", "WA", "98101"], ["DENVER", "CO", "80201"], ["AUSTIN", "TX", "78701"],
  ["PORTLAND", "OR", "97201"], ["SAN JOSE", "CA", "95101"], ["MIAMI", "FL", "33101"],
  ["ATLANTA", "GA", "30301"], ["DALLAS", "TX", "75201"], ["BOSTON", "MA", "02101"],
  ["PHILADELPHIA", "PA", "19101"], ["SAN DIEGO", "CA", "92101"], ["OAKLAND", "CA", "94601"],
  ["FREMONT", "CA", "94536"], ["HAYWARD", "CA", "94541"], ["UNION CITY", "CA", "94587"],
  ["SACRAMENTO", "CA", "95814"], ["MINNEAPOLIS", "MN", "55401"], ["CHARLOTTE", "NC", "28201"],
  ["NASHVILLE", "TN", "37201"], ["RALEIGH", "NC", "27601"], ["SALT LAKE CITY", "UT", "84101"],
  ["PITTSBURGH", "PA", "15201"], ["COLUMBUS", "OH", "43201"], ["INDIANAPOLIS", "IN", "46201"],
  ["TAMPA", "FL", "33601"], ["ORLANDO", "FL", "32801"], ["LAS VEGAS", "NV", "89101"],
  ["BROOKLYN", "NY", "11201"], ["QUEENS", "NY", "11101"], ["NEWARK", "NJ", "07101"],
];

const FIRST_NAMES = [
  "JAMES", "MARY", "JOHN", "PATRICIA", "ROBERT", "JENNIFER", "MICHAEL", "LINDA",
  "DAVID", "ELIZABETH", "WILLIAM", "BARBARA", "RICHARD", "SUSAN", "JOSEPH", "JESSICA",
  "THOMAS", "SARAH", "CHARLES", "KAREN", "CHRISTOPHER", "LISA", "DANIEL", "NANCY",
  "MATTHEW", "BETTY", "ANTHONY", "MARGARET", "MARK", "SANDRA", "DONALD", "ASHLEY",
  "STEVEN", "EMILY", "PAUL", "KIMBERLY", "ANDREW", "DONNA", "JOSHUA", "MICHELLE",
];

const LAST_NAMES = [
  "SMITH", "JOHNSON", "WILLIAMS", "BROWN", "JONES", "GARCIA", "MILLER", "DAVIS",
  "RODRIGUEZ", "MARTINEZ", "HERNANDEZ", "LOPEZ", "GONZALEZ", "WILSON", "ANDERSON",
  "THOMAS", "TAYLOR", "MOORE", "JACKSON", "MARTIN", "LEE", "PEREZ", "THOMPSON",
  "WHITE", "HARRIS", "SANCHEZ", "CLARK", "RAMIREZ", "LEWIS", "ROBINSON", "WALKER",
  "CHEN", "WONG", "KIM", "NGUYEN", "PATEL", "SHAH", "SINGH", "LI", "WANG", "PARK",
];

const EMPLOYER_NAMES = [
  "ACME CORP", "HORIZON TECH", "PACIFIC CONSULTING", "BLUE SKY VENTURES",
  "SUMMIT HEALTHCARE", "METRO SCHOOL DISTRICT", "CITY OF", "STATE OF CALIFORNIA",
  "GOOGLE LLC", "APPLE INC", "AMAZON", "META PLATFORMS", "SALESFORCE",
  "ADOBE INC", "NVIDIA", "CISCO SYSTEMS", "ORACLE", "INTUIT",
  "STANFORD UNIVERSITY", "UC BERKELEY", "COUNTY OF", "US GOVERNMENT",
];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randDigits(n) { return Array.from({length: n}, () => randInt(0, 9)).join(''); }
function randAlpha(n) { return Array.from({length: n}, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[randInt(0, 35)]).join(''); }

function randCity() { return rand(US_CITIES); }
function randName() { return rand(FIRST_NAMES) + ' ' + rand(LAST_NAMES); }

// === FORMAT TEMPLATES ===

function applyCasing(text) {
  const r = Math.random();
  if (r < 0.55) return text.toUpperCase();
  if (r < 0.75) return text;
  if (r < 0.88) return text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return text.toLowerCase();
}

function applySpacing(text) {
  const r = Math.random();
  if (r < 0.7) return text;
  if (r < 0.85) return text.replace(/  +/g, ' ');
  return text.replace(/ /g, '  ').replace(/   +/g, '  ');
}

function fmt(text) {
  return applySpacing(applyCasing(text)).trim();
}

// Chase ACH format: INSTITUTION     PURPOSE    DETAILS    WEB/PPD ID: CODE
function chaseAch(institution, purpose, details) {
  const id = Math.random() > 0.5 ? `WEB ID: ${randAlpha(8)}` : `PPD ID: ${randDigits(9)}`;
  const inst = institution.padEnd(17);
  const purp = purpose.padEnd(11);
  const det = details ? details.padEnd(20) : ''.padEnd(20);
  return fmt(`${inst}${purp}${det}${id}`);
}

// Chase merchant: MERCHANT #STORE CITY or MERCHANT*ORDERID
function chaseMerchant(merchant, opts = {}) {
  const r = Math.random();
  if (r < 0.3 && !opts.noStore) {
    return fmt(`${merchant} ${randDigits(randInt(4, 8))}`);
  }
  if (r < 0.5 && !opts.noStore) {
    return fmt(`${merchant} #${randDigits(randInt(3, 5))} ${randCity()[0]}`);
  }
  if (r < 0.65) {
    return fmt(`${merchant}*${randAlpha(randInt(8, 12))}`);
  }
  if (r < 0.8) {
    const [city] = randCity();
    return fmt(`${merchant} - ${city}`);
  }
  return fmt(merchant);
}

// Apple Card: MERCHANT ADDRESS CITY ZIP STATE COUNTRY
function appleCard(merchant) {
  const [city, state, zip] = randCity();
  const addr = `${randInt(100, 9999)} ${rand(['MAIN', 'MARKET', 'BROADWAY', 'OAK', 'ELM', 'PARK', 'MISSION', 'UNIVERSITY', 'CENTER', 'INDUSTRIAL'])} ${rand(['ST', 'AVE', 'BLVD', 'RD', 'DR', 'WAY', 'PKWY', 'CT', 'LN'])}`;
  // Sometimes zip smashes into city (Apple Card quirk)
  const r = Math.random();
  if (r < 0.3) {
    return fmt(`${merchant} ${addr} ${city}${zip} ${state} USA`);
  }
  if (r < 0.6) {
    return fmt(`${merchant} ${addr} ${city} ${zip} ${state} USA`);
  }
  return fmt(`${merchant} ${addr} ${city} ${zip}-${randDigits(4)}${state} USA`);
}

// PayPal: Multiple formats — PayPal is a card issuer, not just a wrapper.
// People use PayPal credit/debit cards at any merchant.
function paypal(merchant) {
  const r = Math.random();
  // Native PayPal prefixes (PayPal credit card statement)
  if (r < 0.30) {
    const prefix = rand([
      'PreApproved Payment Bill User Payment:',
      'Express Checkout Payment:',
      'Subscription Payment:',
      'Payment to:',
      'Buyer Payment:',
    ]);
    return fmt(`${prefix} ${merchant}`);
  }
  // PP* and PYPL* prefixes (Chase/other bank statements showing PayPal)
  if (r < 0.50) {
    return rand([
      `PP*${applyCasing(merchant)}`,
      `PYPL*${applyCasing(merchant)}`,
      `PAYPAL *${applyCasing(merchant)}`,
    ]);
  }
  // PAYPAL INST XFER format (Chase ACH)
  if (r < 0.70) {
    return `PAYPAL           INST XFER  ${merchant.toUpperCase().padEnd(16)}WEB ID: PAYPALSI${randDigits(2)}`;
  }
  // PayPal with merchant and refcode
  if (r < 0.85) {
    return fmt(`PAYPAL *${merchant} ${randAlpha(10)}`);
  }
  // PYPL prefix variants
  return rand([
    fmt(`PYPL *${merchant}`),
    fmt(`PYPL*${merchant}`),
    fmt(`PAYPAL *PYPL ${applyCasing(merchant)}`),
  ]);
}

// Capital One: Withdrawal/Deposit from DESCRIPTION
function capitalOne(description, isDebit = true) {
  if (isDebit) {
    return fmt(`Withdrawal from ${description}`);
  }
  const prefix = rand(['Deposit from', 'Preauthorized Deposit from']);
  return fmt(`${prefix} ${description}`);
}

// Simple/Mercury plain: MERCHANT or MERCHANT.COM — minimal context, just the name
function simple(merchant) {
  const r = Math.random();
  if (r < 0.15) return fmt(`${merchant}.COM`);
  if (r < 0.25) return fmt(`${merchant}.com`);
  if (r < 0.40) return fmt(`${merchant}, ${rand(['INC', 'LLC', 'CORP', 'CO'])}`);
  if (r < 0.50) return fmt(`${merchant} INC.`);
  return fmt(merchant);
}

// Mercury semicolon format: INSTITUTION; DESCRIPTION; NAME
function mercurySemicolon(merchant) {
  const desc = rand(['Payment', 'Purchase', 'Subscription', 'Service', 'Charge', 'Billing']);
  return fmt(`${merchant}; ${desc}`);
}

// Capital One with Preauthorized prefix
function capitalOnePreauth(merchant, isDebit = true) {
  if (isDebit) {
    return fmt(`Preauthorized Withdrawal to ${merchant}`);
  }
  return fmt(`Preauthorized Deposit from ${merchant}`);
}

// PayPal/Express Checkout wrapper — applies to any category via randomFormat()
function paypalWrapped(merchant) {
  const r = Math.random();
  if (r < 0.20) return `PreApproved Payment Bill User Payment: ${applyCasing(merchant)}`;
  if (r < 0.35) return `Express Checkout Payment: ${applyCasing(merchant)}`;
  if (r < 0.50) return `PP*${applyCasing(merchant)}`;
  if (r < 0.60) return `PYPL*${applyCasing(merchant)}`;
  if (r < 0.70) return `PYPL *${applyCasing(merchant)}`;
  if (r < 0.85) return `PAYPAL *${applyCasing(merchant)}`;
  return `PAYPAL           INST XFER  ${merchant.toUpperCase().padEnd(16)}WEB ID: PAYPALSI${randDigits(2)}`;
}

// Pick a random format — covers all bank structure types
function randomFormat(merchant, opts = {}) {
  const r = Math.random();
  if (r < 0.22) return chaseMerchant(merchant, opts);          // Chase merchant format
  if (r < 0.38) return appleCard(merchant);                     // Apple Card full address
  if (r < 0.46) return paypal(merchant);                        // PayPal native prefix
  if (r < 0.54) return capitalOne(merchant, opts.isDebit !== false); // Capital One Withdrawal/Deposit
  if (r < 0.60) return capitalOnePreauth(merchant, opts.isDebit !== false); // Capital One Preauthorized
  if (r < 0.68) return paypalWrapped(merchant);                 // PayPal wrapper (across all categories)
  if (r < 0.74) return mercurySemicolon(merchant);              // Mercury semicolon format
  return simple(merchant);                                       // Mercury plain / minimal format (26%)
}

// === CATEGORY GENERATORS ===

function genRestaurants() {
  const pool = [
    ...merchants.restaurants.fastFood,
    ...merchants.restaurants.sitDown,
    ...merchants.restaurants.coffee,
    ...merchants.restaurants.delivery,
    ...merchants.restaurants.local,
  ];
  const m = rand(pool);
  const r = Math.random();

  // 10% PayPal-wrapped restaurant purchases
  if (r < 0.10) return paypal(m);

  // Real pattern: MCDONALD'S F11838 or McDonalds 5536 (mixed case, F-prefix store IDs)
  if (m.includes("MCDONALD")) {
    return rand([
      fmt(`MCDONALD'S F${randDigits(5)}`),
      `McDonalds ${randDigits(4)}`,
      appleCard(`MCDONALDS ${randDigits(4)} ${randInt(10000,99999)} ${rand(['MAIN','BROADWAY','INDUSTRIAL PARKWAY','CENTER'])} ${rand(['ST','AVE','BLVD'])}`),
    ]);
  }

  // Real pattern: compressed names without spaces/apostrophes (e.g., DAVESHOTCHICKEN, CHICKFILA, JACKINTHEBOX)
  if (r < 0.20) {
    const compressedChains = [
      ['DAVESHOTCHICKEN', "DAVE'S HOT CHICKEN"],
      ['CHICKFILA', "CHICK-FIL-A"],
      ['JACKINTHEBOX', "JACK IN THE BOX"],
      ['PANDAEXPRESS', "PANDA EXPRESS"],
      ['RAISINGCANES', "RAISING CANE'S"],
      ['ELPOLLOLOCO', "EL POLLO LOCO"],
      ['WINGSTOP', "WINGSTOP"],
      ['INNOUT', "IN-N-OUT"],
    ];
    const [compressed, full] = rand(compressedChains);
    const [city, state, zip] = randCity();
    return rand([
      compressed,
      fmt(`${compressed} ${randDigits(5)}`),
      fmt(`${compressed} ${city}`),
      fmt(`${full} ${city} ${randDigits(4)}`),
    ]);
  }

  // POS system prefixes (Toast, Square, Clover) — strong restaurant signal
  if (r < 0.40) {
    const restaurantNames = [
      'MENDOCINO FARMS', 'STIX FOOD HALL', 'THE FOOD COURT', 'FARM HOUSE KITCHEN',
      'GREEN MARKET CAFE', 'FRESH FOOD CO', 'THE KITCHEN TABLE', 'FOOD FACTORY',
      'HARVEST TABLE', 'GARDEN GRILL', 'CREPE BAR', 'POKE BOWL', 'RAMEN HOUSE',
      'CURRY HOUSE', 'TACO SPOT', 'BURGER JOINT', 'PIZZA PLACE', 'SUSHI BAR',
      'NOODLE HOUSE', 'WING SHACK', 'BBQ PIT', 'SOUP KITCHEN', 'BAGEL SHOP',
    ];
    const name = Math.random() < 0.5 ? rand(restaurantNames) : m;
    const prefix = rand(['TST*', 'TST* ', 'SQ *', 'CLV*']);
    return rand([
      `${prefix}${applyCasing(name)}`,
      `${prefix}${applyCasing(name)} - ${randCity()[0]}`,
      `${prefix}${applyCasing(name)} #${randDigits(3)}`,
    ]);
  }

  // Real pattern: PAYPAL INST XFER STARBUCKS WEB ID: PAYPALSI77
  if (merchants.restaurants.coffee.includes(m) || merchants.restaurants.delivery.includes(m)) {
    if (Math.random() < 0.2) {
      return `PAYPAL           INST XFER  ${m.padEnd(16)}WEB ID: PAYPALSI${randDigits(2)}`;
    }
  }

  // Delivery: DOORDASH*RESTAURANT or UBER EATS ORDERID
  if (merchants.restaurants.delivery.includes(m)) {
    if (Math.random() < 0.4) return fmt(`${m}*${rand(merchants.restaurants.local)}`);
    return chaseMerchant(m);
  }

  // Default: merchant + store number or Apple Card format
  if (Math.random() < 0.3) return appleCard(m);
  return chaseMerchant(m);
}

function genGroceries() {
  const pool = [...merchants.groceries.chains, ...merchants.groceries.warehouse];
  const m = rand(pool);
  const r = Math.random();
  // 8% PayPal-wrapped grocery purchases
  if (r < 0.08) return paypal(m);
  // Real pattern: SAFEWAY #1197, 99 RANCH #1766, WHOLEFDS FRE #10467
  if (r < 0.25) return fmt(`${m} #${randDigits(randInt(3, 5))}`);
  // Abbreviated forms: WHOLEFDS, TRADERJOES
  if (r < 0.35) {
    const abbrev = m.replace(/[' ]/g, '').substring(0, randInt(7, 10)).toUpperCase();
    return fmt(`${abbrev} ${rand(['', randCity()[0].substring(0, 3)])} #${randDigits(randInt(3, 5))}`);
  }
  // Real pattern: LUCKY #NNN, SAVEMART #NN, abbreviated store names
  if (r < 0.45) {
    const abbrForms = [
      'WHOLEFDS', 'WHOLEFDS FRE', 'TRADERJOES', 'SAVEMART',
      'SMARTFINAL', 'FOODMAXX', 'GROCOUTLT',
    ];
    const abbrev = rand(abbrForms);
    return fmt(`${abbrev} #${randDigits(randInt(2, 5))} ${randCity()[0].substring(0, 8)}`);
  }
  // Real pattern: STORE NNNN CITY
  if (r < 0.55) return fmt(`${m} ${randDigits(4)} ${randCity()[0]}`);
  // SQ* patterns for farmers markets, local grocers
  if (r < 0.65) {
    const groceryNames = [
      'FRESH PRODUCE', 'FARMERS MARKET', 'ORGANIC FARM', 'GREEN VALLEY',
      'LOCAL HARVEST', 'FARM STAND', 'PRODUCE MARKET', 'FRUIT STAND',
      m,
    ];
    return `SQ *${applyCasing(rand(groceryNames))}`;
  }
  // Apple Card with address
  if (r < 0.80) return appleCard(m);
  return chaseMerchant(m);
}

function genShopping() {
  const r = Math.random();

  // 10% PayPal-wrapped shopping purchases
  if (r < 0.10) {
    const allShoppingPool = [
      ...merchants.shopping.online, ...merchants.shopping.retail,
      ...merchants.shopping.department, ...merchants.shopping.electronics,
      ...merchants.shopping.pet, ...merchants.shopping.dtc,
      ...merchants.shopping.liquor,
    ];
    return paypal(rand(allShoppingPool));
  }

  // 5% marketplace patterns (TikTok Shop, Facebook Marketplace, etc.)
  if (r < 0.15) {
    const marketplace = rand(['TIKTOK SHOP', 'FACEBOOK MARKETPLACE', 'MERCARI', 'OFFERUP']);
    return appleCard(marketplace);
  }

  // 30% Amazon patterns (dominant in real data)
  // Key signal: *ORDERID suffix = one-time PURCHASE (Shopping), NOT subscription
  if (r < 0.35) {
    const orderid = randAlpha(randInt(8, 11));
    return rand([
      `Amazon.com*${orderid}`,
      `Amazon.com*${orderid}`,
      `AMAZON MKTPL*${orderid}`,
      `AMAZON MKTPL*${orderid}`,
      `AMZN MKTP US*${orderid}`,
      `Kindle Unltd*${orderid}`,
      `AMZN DIGITAL*${orderid}`,
      `AMAZON MARKTPLACE*${orderid}`,
    ]);
  }

  // 15% Target patterns
  if (r < 0.55) {
    return rand([
      fmt(`TARGET T-${randDigits(4)}`),
      fmt(`TARGET ${randDigits(8)}`),
      fmt(`TARGET #${randDigits(4)} ${randCity()[0]}`),
    ]);
  }

  // 10% Walmart
  if (r < 0.65) {
    return rand([
      fmt(`WALMART SUPERCENTER #${randDigits(4)}`),
      fmt(`WAL-MART #${randDigits(4)}`),
      fmt(`WALMART ${randDigits(4)} ${randCity()[0]}`),
    ]);
  }

  // Remaining: other retail with store numbers (real pattern: STORE #NNNN or STORE NNNN)
  const pool = [
    ...merchants.shopping.retail,
    ...merchants.shopping.department,
    ...merchants.shopping.electronics,
    ...merchants.shopping.office,
    ...merchants.shopping.online.filter(m => m !== 'AMAZON'),
    ...merchants.shopping.pet,
    ...merchants.shopping.dtc,
    ...merchants.shopping.resale,
    ...merchants.shopping.liquor,
  ];
  const m = rand(pool);
  const fmt2 = Math.random();
  if (fmt2 < 0.25) return fmt(`${m} #${randDigits(randInt(3, 5))}`);
  if (fmt2 < 0.40) return fmt(`${m} ${randDigits(randInt(4, 6))}`);
  if (fmt2 < 0.55) return fmt(`${m} #${randDigits(4)} ${randCity()[0]}`);
  if (fmt2 < 0.65) return appleCard(m);
  return chaseMerchant(m);
}

function genTransportation() {
  const r = Math.random();
  if (r < 0.35) {
    const gas = rand(merchants.transportation.gas);
    return chaseMerchant(gas);
  }
  if (r < 0.47) {
    const ride = rand(merchants.transportation.rideshare);
    // Uber TRIP vs Uber EATS distinction
    return fmt(`${ride}   *TRIP  ${randCity()[0]}  ${randAlpha(6)}`);
  }
  if (r < 0.58) {
    return randomFormat(rand(merchants.transportation.auto));
  }
  if (r < 0.68) {
    return randomFormat(rand(merchants.transportation.parking));
  }
  if (r < 0.75) {
    return randomFormat(rand(merchants.transportation.transit));
  }
  if (r < 0.83) {
    // EV charging
    const ev = rand(merchants.transportation.ev);
    return rand([
      fmt(`CHARGEPOINT *${ev} STATION ${randDigits(4)}`),
      fmt(`${ev} #${randDigits(5)}`),
      fmt(`${ev} ${randCity()[0]}`),
      appleCard(ev),
    ]);
  }
  if (r < 0.90) {
    // Tolls — ACH/autopay format
    const toll = rand(merchants.transportation.tolls);
    return rand([
      `${toll.padEnd(17)}TOLL PMT${' '.repeat(19)}WEB ID: ${randAlpha(8)}`,
      fmt(`${toll} REPLENISH`),
      fmt(`${toll} AUTO REPLENISH`),
      fmt(`${toll} TOLLS`),
    ]);
  }
  if (r < 0.95) {
    // Car wash
    const wash = rand(merchants.transportation.carwash);
    return randomFormat(wash);
  }
  // DMV
  const dmv = rand(merchants.transportation.dmv);
  return rand([
    fmt(`FD *${dmv} VFC`),
    fmt(`${dmv} FEE`),
    appleCard(dmv),
    fmt(dmv),
  ]);
}

function genEntertainment() {
  const r = Math.random();
  // 15% gambling / sportsbook
  if (r < 0.15) {
    const m = rand(merchants.entertainment.gambling);
    return rand([
      fmt(m),
      appleCard(m),
      fmt(`${m} DEPOSIT`),
      fmt(`${m} SPORTSBOOK`),
      fmt(`${m} ONLINE`),
    ]);
  }
  // 15% gaming with platform-specific formats
  if (r < 0.30) {
    const m = rand(merchants.entertainment.gaming);
    return rand([
      fmt(`${m} PURCHASE`),
      fmt(`${m} GAME`),
      fmt(`VALVE STEAM PURCHASE`),
      randomFormat(m),
    ]);
  }
  const pool = [
    ...merchants.entertainment.events,
    ...merchants.entertainment.other,
    ...merchants.entertainment.sports,
    ...merchants.entertainment.recreation,
  ];
  return randomFormat(rand(pool));
}

function genUtilities() {
  const r = Math.random();

  // 10% waste/trash
  if (r < 0.10) {
    const waste = rand(merchants.utilities.waste);
    const suffix = rand(['TRASH', 'WASTE SVC', 'REFUSE', 'RECYCLING', 'PICKUP', 'COLLECTION']);
    return rand([
      `${waste.padEnd(17)}${suffix.padEnd(27)}WEB ID: ${randAlpha(8)}`,
      fmt(`${waste} ${suffix}`),
      capitalOne(`${waste} ${suffix}`),
      appleCard(waste),
    ]);
  }

  // 5% solar
  if (r < 0.15) {
    const solar = rand(merchants.utilities.solar);
    return rand([
      `${solar.padEnd(17)}SOLAR PMT${' '.repeat(18)}WEB ID: ${randAlpha(8)}`,
      fmt(`${solar} SOLAR PAYMENT`),
      fmt(`${solar} ENERGY`),
      capitalOne(`${solar} SOLAR`),
    ]);
  }

  const pool = [
    ...merchants.utilities.electric,
    ...merchants.utilities.internet,
    ...merchants.utilities.water,
    ...merchants.utilities.phone,
  ];
  const m = rand(pool);
  // 40% ACH format — key signal: utility company name + UTIL/BILL/EBILL purpose
  if (r < 0.50) {
    const purpose = rand(['UTIL PMT', 'BILL PAY', 'AUTOPAY', 'ONLINE PMT', 'EBILL', 'CABLE SVC', 'INTERNET', 'ELECTRIC', 'PHONE SVC']);
    return `${m.padEnd(17)}${purpose.padEnd(27)}WEB ID: ${randAlpha(8)}`;
  }
  // 15% Capital One format
  if (r < 0.62) {
    return capitalOne(`${m} ${rand(['CABLE', 'INTERNET', 'ELECTRIC', 'GAS', 'WATER', 'PHONE', 'WEB ONLINE'])}`);
  }
  // 15% simple with store number
  if (r < 0.75) {
    return fmt(`${m} ${randDigits(randInt(4, 7))}`);
  }
  // Apple Card
  if (r < 0.87) {
    return appleCard(m);
  }
  return fmt(m);
}

function genSubscription() {
  const pool = [
    ...merchants.subscription.streaming,
    ...merchants.subscription.software,
    ...merchants.subscription.news,
    ...merchants.subscription.fitness,
    ...merchants.subscription.other,
    ...merchants.subscription.saas,
    ...merchants.subscription.social,
    ...merchants.subscription.dating,
    ...merchants.subscription.business,
  ];
  const m = rand(pool);
  const r = Math.random();

  // Real pattern: APPLE.COM/BILL ONE APPLE PARK WAY... (Apple Card format)
  if (r < 0.10) {
    return appleCard('APPLE.COM/BILL');
  }
  // Real pattern: PP*APPLE.COM/BILL (Chase)
  if (r < 0.15) {
    return `PP*APPLE.COM/BILL`;
  }
  // Real pattern: PAYPAL INST XFER MERCHANT WEB ID: PAYPALSI77
  if (r < 0.28) {
    return `PAYPAL           INST XFER  ${m.padEnd(16)}WEB ID: PAYPALSI${randDigits(2)}`;
  }
  // Real pattern: GOOGLE *YOUTUBE TV or GOOGLE *SERVICE
  if (r < 0.36) {
    return fmt(`GOOGLE *${m}`);
  }
  // Real pattern: Microsoft*Microsoft 365 P or Experian* Credit Report
  if (r < 0.45) {
    return `${m}* ${rand([m + ' Plus', m + ' Premium', m + ' Pro', 'Credit Report', 'Monthly', 'Subscription'])}`;
  }
  // Real pattern: PreApproved Payment Bill User Payment: MERCHANT (PayPal)
  if (r < 0.55) {
    return `PreApproved Payment Bill User Payment: ${m}`;
  }
  // Real pattern: Subscription Payment: MERCHANT (PayPal)
  if (r < 0.62) {
    return `Subscription Payment: ${m}`;
  }
  // Real pattern: MERCHANT.COM (simple)
  if (r < 0.72) {
    return rand([fmt(`${m}.COM`), `${m}.com`, fmt(`HELP.${m}.COM`)]);
  }
  // Apple Card full address format for SaaS
  if (r < 0.82 && merchants.subscription.saas.includes(m)) {
    return appleCard(m);
  }
  // Simple name
  return fmt(m);
}

function genHealthcare() {
  const r = Math.random();

  // 15% telehealth
  if (r < 0.15) {
    const m = rand(merchants.healthcare.telehealth);
    return rand([
      fmt(`${m} TELEHEALTH`),
      fmt(`${m} VIRTUAL VISIT`),
      simple(m),
      paypal(m),
    ]);
  }

  // 12% dental
  if (r < 0.27) {
    const m = rand(merchants.healthcare.dental);
    return rand([
      randomFormat(m),
      fmt(`${m} DENTAL OFFICE`),
      appleCard(m),
    ]);
  }

  // 10% vision
  if (r < 0.37) {
    const m = rand(merchants.healthcare.vision);
    return rand([
      randomFormat(m),
      fmt(`${m} OPTICAL`),
      fmt(`${m} EYE CARE`),
    ]);
  }

  // 10% hospital
  if (r < 0.47) {
    const m = rand(merchants.healthcare.hospital);
    return rand([
      randomFormat(m),
      fmt(`${m} MEDICAL`),
      fmt(`${m} HOSPITAL`),
      `${m.padEnd(17)}MEDICAL PMT${' '.repeat(16)}WEB ID: ${randAlpha(8)}`,
    ]);
  }

  const pool = [
    ...merchants.healthcare.pharmacy,
    ...merchants.healthcare.provider,
    ...merchants.healthcare.mental,
  ];
  const m = rand(pool);
  if (merchants.healthcare.provider.includes(m)) {
    // Doctor names vary wildly
    const name = rand(['DR.', 'DR', '']) + ' ' + rand(LAST_NAMES);
    const specialty = rand(['FAMILY MEDICINE', 'DENTAL', 'OPTOMETRY', 'DERMATOLOGY', 'PEDIATRICS', 'ORTHOPEDICS', 'CARDIOLOGY', 'PHYSICAL THERAPY', 'CHIROPRACTIC', 'PSYCHIATRY']);
    return fmt(`${name} ${specialty}`);
  }
  return randomFormat(m);
}

function genInsurance() {
  const pool = [
    ...merchants.insurance.auto,
    ...merchants.insurance.home,
    ...merchants.insurance.life,
    ...merchants.insurance.health,
  ];
  const m = rand(pool);
  const r = Math.random();
  // 40% ACH format — this is the main confusion point with Income/Utilities
  // Key signal: institution name contains INS, INSURANCE, MUTUAL, LIFE, etc.
  if (r < 0.40) {
    const purpose = rand(['INSPAYMENT', 'INSURANCE', 'INS PREMIUM', 'PREMIUM', 'EFT PYMT', 'BILLING']);
    return `${m.padEnd(17)}${purpose.padEnd(27)}PPD ID: ${randDigits(10)}`;
  }
  // 20% with explicit insurance suffix
  if (r < 0.60) {
    const suffix = rand([' BILLING', ' PREMIUM', ' PAYMENT', ' GRP', ' INS', ' INSURANCE CO', ' AUTO PREMIUM', ' HOME PREMIUM']);
    return fmt(`${m}${suffix}`);
  }
  // 15% PayPal format
  if (r < 0.75) {
    return `PreApproved Payment Bill User Payment: ${m}`;
  }
  // Apple Card format
  return appleCard(m);
}

function genMortgage() {
  const bank = rand(merchants.mortgage.banks);
  const r = Math.random();
  if (r < 0.30) {
    return chaseAch(bank, 'MORTGAGE', randDigits(8));
  }
  if (r < 0.50) {
    return fmt(`${bank} PAYMENT`);
  }
  if (r < 0.65) {
    return fmt(`MORTGAGE PAYMENT`);
  }
  if (r < 0.75) {
    return fmt(`Principal Pmt`);
  }
  if (r < 0.85) {
    return rand([
      fmt(`${bank} ESCROW`),
      fmt(`${bank} ESCROW PAYMENT`),
    ]);
  }
  return rand([
    capitalOne(`${bank} MTG PYMT`),
    fmt(`${bank} HOME LOAN`),
    fmt(`MTG PMT ${bank}`),
  ]);
}

function genRent() {
  const mgr = rand(merchants.rent.propertyMgmt);
  const r = Math.random();
  if (r < 0.30) {
    return chaseAch(mgr, 'RENT PMT', randDigits(8));
  }
  if (r < 0.50) {
    return fmt(`${mgr} RENT PAYMENT`);
  }
  if (r < 0.65) {
    return rand([
      fmt(`${mgr} LEASE PAYMENT`),
      fmt(`${mgr} MONTHLY RENT`),
      fmt(`${mgr} APT RENT`),
    ]);
  }
  if (r < 0.78) {
    return capitalOne(`${mgr} RENT`);
  }
  if (r < 0.88) {
    // ACH format
    const purpose = rand(['RENT', 'RENT PMT', 'LEASE PMT', 'APT RENT', 'MONTHLY RENT']);
    return `${mgr.padEnd(17)}${purpose.padEnd(27)}PPD ID: ${randDigits(10)}`;
  }
  // Simple format
  return fmt(`${mgr} RENT`);
}

function genTravel() {
  const r = Math.random();
  if (r < 0.25) return randomFormat(rand(merchants.travel.hotels));
  if (r < 0.45) return randomFormat(rand(merchants.travel.airlines));
  if (r < 0.60) return randomFormat(rand(merchants.travel.booking));
  if (r < 0.72) return randomFormat(rand(merchants.travel.rental));
  if (r < 0.85) {
    const cruise = rand(merchants.travel.cruise);
    return rand([
      randomFormat(cruise),
      fmt(`${cruise} LINE`),
      fmt(`${cruise} BOOKING ${randDigits(8)}`),
    ]);
  }
  // Airport services
  const airport = rand(merchants.travel.airport);
  return rand([
    randomFormat(airport),
    fmt(`${airport} ENROLLMENT`),
    fmt(`${airport} ${randCity()[0]}`),
  ]);
}

function genEducation() {
  const r = Math.random();
  if (r < 0.30) return randomFormat(rand(merchants.education.online), { noStore: true });
  if (r < 0.50) return randomFormat(rand(merchants.education.books));
  if (r < 0.65) {
    const school = rand(merchants.education.tuition);
    return fmt(`${school} OF ${randCity()[0]} TUITION`);
  }
  if (r < 0.80) {
    const tutor = rand(merchants.education.tutoring);
    return rand([
      randomFormat(tutor, { noStore: true }),
      fmt(`${tutor} TUTORING`),
      fmt(`${tutor} LEARNING CENTER`),
    ]);
  }
  // Certification / professional development
  const cert = rand(merchants.education.certification);
  return rand([
    randomFormat(cert, { noStore: true }),
    simple(cert),
    paypal(cert),
  ]);
}

function genPersonalCare() {
  const pool = [
    ...merchants.personalCare.salon,
    ...merchants.personalCare.beauty,
    ...merchants.personalCare.gym,
    ...merchants.personalCare.spa,
    ...merchants.personalCare.barber,
    ...merchants.personalCare.skincare,
  ];
  return randomFormat(rand(pool));
}

// Business removed — it's an account-level annotation, not a transaction-level category.
// Business merchants redistributed to Subscription (SaaS) and Shopping (office/domain).

function genTransfer() {
  const r = Math.random();
  if (r < 0.15) {
    const app = rand(merchants.transfer.p2p);
    const name = randName();
    const [city, state] = randCity();
    if (app === 'ZELLE') {
      // "Zelle payment to" = always debit (sending money)
      return { description: `Zelle payment to ${name}, ${city}, ${state} ${randDigits(11)}`, sign: 'debit' };
    }
    return { description: fmt(`${app} PAYMENT TO ${name}`), sign: 'debit' };
  }
  if (r < 0.28) {
    const cc = rand(merchants.transfer.ccPayment);
    const desc = rand([
      `${cc.padEnd(37)}PPD ID: ${randDigits(10)}`,
      `AUTOMATIC PAYMENT - THANK`,
      `AUTOMATIC PAYMENT - THANK`,
      `Payment Thank You - Web`,
      `Payment Thank You - 2nd A`,
    ]);
    // CC payments: on checking = debit (paying the CC), on credit = credit (receiving payment)
    // Generate both directions for training
    return { description: desc, sign: Math.random() < 0.5 ? 'debit' : 'credit' };
  }
  if (r < 0.44) {
    const ddaBanks = [
      ...merchants.transfer.bank,
      "CITIBANK", "ALLY BANK", "CAPITAL ONE", "DISCOVER BANK", "CITIZENS BANK",
      "KEYBANK", "HUNTINGTON", "M&T BANK", "COMERICA", "ZIONS BANK",
      "FIRST REPUBLIC", "SVB", "TRUIST", "BMO HARRIS",
    ];
    const bank = rand(ddaBanks);
    const r2 = Math.random();
    let desc;
    // 50% DDA TO DDA patterns (boosted) — prevents misclassification as Insurance
    if (r2 < 0.50) {
      desc = rand([
        `${bank.padEnd(17)}DDA TO DDA ${randAlpha(10).padEnd(16)}WEB ID: ${randAlpha(10)}`,
        `${bank.padEnd(17)}IFI DDA TO DDA ${randAlpha(8).padEnd(12)}WEB ID: ${randAlpha(10)}`,
        `${bank.padEnd(17)}XFER DDA TO DDA${randAlpha(8).padEnd(12)}WEB ID: ${randAlpha(10)}`,
        `${bank.padEnd(17)}DDA TO DDA REFCODE ${randAlpha(8)}  WEB ID: ${randAlpha(10)}`,
        `${bank.padEnd(17)}DDA TO DDA ${randAlpha(10).padEnd(16)}PPD ID: ${randDigits(10)}`,
        `${bank} IFI DDA TO DDA ${randAlpha(8)} WEB ID: INTFITRVOS`,
      ]);
    } else {
      desc = rand([
        `Online Transfer ${randDigits(11)} to ${rand(['Savings', 'Checking', 'Brokerage'])} #######${randDigits(4)} transaction #: ${randDigits(7)}`,
        `Online Transfer ${randDigits(11)} from ${rand(['Savings', 'Checking', 'Brokerage'])} ...${randDigits(4)} transaction#: ${randDigits(7)}`,
        capitalOne(`${bank} Ext Trnsfr`),
        fmt(`Deposit from ${bank} Ext Trnsfr`),
        fmt(`Preauthorized Deposit from ${bank}`),
      ]);
    }
    return { description: desc, sign: Math.random() < 0.5 ? 'debit' : 'credit' };
  }
  if (r < 0.50) {
    // ACH DEPOSIT = credit (money arriving)
    return { description: `ACH DEPOSIT INTERNET TRANSFER FROM ACCOUNT ENDING IN ${randDigits(4)}`, sign: 'credit' };
  }
  if (r < 0.62) {
    return { description: fmt(`MONTHLY INSTALLMENTS (${randInt(1, 12)} OF ${rand([12, 24, 36])})`), sign: 'debit' };
  }
  if (r < 0.70) {
    const xferMerchant = rand([
      '', '',
      'PAYPAL_CREDIT_C',
      'BARCLAYCARD',
      'SYNCHRONY',
      ...merchants.transfer.ccPayment.slice(0, 5),
    ]);
    return { description: `PAYPAL           INST XFER  ${xferMerchant.padEnd(16)}WEB ID: PAYPALSI${randDigits(2)}`, sign: Math.random() < 0.5 ? 'debit' : 'credit' };
  }
  // Brokerage sweep/transfer patterns
  if (r < 0.82) {
    const brokerage = rand(merchants.transfer.brokerage);
    const desc = rand([
      fmt(`${brokerage} MONEYLINK PPD ID: ${randDigits(9)}`),
      fmt(`${brokerage} ACH TRANSFER`),
      fmt(`Manual DB-Bkrg ${randDigits(2)}/${randDigits(2)}`),
      fmt(`Manual CR-Bkrg ${randDigits(2)}/${randDigits(2)}`),
      `${brokerage.padEnd(17)}MONEYLINK${' '.repeat(18)}PPD ID: ${randDigits(9)}`,
      fmt(`${brokerage} BROKERAGE TRANSFER`),
      fmt(`${brokerage} INVESTMENTS MONEYLINE`),
      fmt(`TRADESTATION PAYMENTS ${randDigits(15)} WEB ID: ${randDigits(8)}`),
    ]);
    return { description: desc, sign: Math.random() < 0.5 ? 'debit' : 'credit' };
  }
  // Fintech/business banking transfers
  if (r < 0.88) {
    const platform = rand(merchants.transfer.fintech);
    const accountName = rand(['DoDataThings', 'MyBusiness', rand(EMPLOYER_NAMES), randName().split(' ')[1]]);
    const desc = rand([
      `Online Transfer ${randDigits(11)} to ${accountName}-${platform} ########${randDigits(4)} transaction #: ${randDigits(7)}`,
      `Online Transfer ${randDigits(11)} from ${accountName}-${platform} ########${randDigits(4)} transaction#: ${randDigits(7)}`,
      fmt(`${platform} TRANSFER`),
      fmt(`${platform} ACH TRANSFER`),
      `${platform.padEnd(17)}TRANSFER${' '.repeat(19)}PPD ID: ${randDigits(8)}`,
    ]);
    return { description: desc, sign: Math.random() < 0.5 ? 'debit' : 'credit' };
  }
  // BNPL patterns
  if (r < 0.93) {
    const bnpl = rand(merchants.transfer.bnpl);
    const desc = rand([
      fmt(`${bnpl} PAYMENT`),
      fmt(`${bnpl} INSTALLMENT`),
      fmt(`${bnpl} PMT ${randDigits(8)}`),
      `${bnpl.padEnd(17)}INSTALLMENT${' '.repeat(16)}WEB ID: ${randAlpha(8)}`,
    ]);
    return { description: desc, sign: 'debit' };
  }
  // Loan/CC payment — always debit from checking perspective
  if (r < 0.90) {
    const desc = rand([
      fmt(`${rand(merchants.transfer.bank)} LOAN PMT`),
      fmt(`Payment to ${rand(merchants.transfer.bank)} card ending in ${randDigits(4)}`),
      fmt(`${rand(merchants.transfer.bank)} PAYMENT`),
      fmt(`RETURNED PAYMENT`),
      fmt(`General Payment: ${rand(merchants.transfer.bank)}`),
    ]);
    return { description: desc, sign: 'debit' };
  }
  // Wire transfers — both directions
  if (r < 0.94) {
    const name = randName();
    const bank = rand(merchants.transfer.bank);
    const isOutgoing = Math.random() < 0.5;
    const desc = rand([
      fmt(`${isOutgoing ? 'OUTGOING' : 'INCOMING'} WIRE TRANSFER`),
      fmt(`${isOutgoing ? '' : 'INCOMING '}WIRE TRANSFER ${isOutgoing ? 'TO' : 'FROM'} ${name}`),
      fmt(`FED WIRE ${isOutgoing ? 'TO' : 'FROM'} ${bank}`),
      fmt(`DOMESTIC WIRE TRANSFER`),
      fmt(`INTERNATIONAL WIRE TRANSFER`),
      `WIRE TRF ${isOutgoing ? 'OUT' : 'IN'} REF: ${randDigits(14)}`,
    ]);
    return { description: desc, sign: isOutgoing ? 'debit' : 'credit' };
  }
  // Cashier's checks — always debit
  if (r < 0.96) {
    const desc = rand([
      fmt(`CASHIER'S CHECK #${randDigits(6)}`),
      fmt(`OFFICIAL CHECK PURCHASED`),
      fmt(`CASHIER CHECK WITHDRAWAL`),
      fmt(`TELLER CHECK #${randDigits(6)}`),
      fmt(`COUNTER CHECK`),
    ]);
    return { description: desc, sign: 'debit' };
  }
  // ATM deposits — always credit
  if (r < 0.98) {
    const desc = rand([
      fmt(`ATM DEPOSIT`),
      fmt(`ATM CHECK DEPOSIT`),
      fmt(`ATM CASH DEPOSIT`),
      fmt(`ATM DEPOSIT ${randCity()[0]}`),
      fmt(`MOBILE DEPOSIT`),
      fmt(`REMOTE DEPOSIT`),
      fmt(`MOBILE CHECK DEPOSIT`),
    ]);
    return { description: desc, sign: 'credit' };
  }
  // ATM withdrawals — always debit
  const [city, state] = randCity();
  const desc = rand([
    fmt(`ATM WITHDRAWAL`),
    fmt(`NON-NETWORK ATM WITHDRAWAL`),
    fmt(`ATM CASH WITHDRAWAL ${city}`),
    fmt(`ATM #${randDigits(6)} WITHDRAWAL`),
    fmt(`ALLPOINT ATM WITHDRAWAL`),
    fmt(`ATM WITHDRAWAL - ${randInt(100, 9999)} ${rand(['MAIN', 'MARKET', 'BROADWAY'])} ST ${city} ${state}`),
    fmt(`NON-CHASE ATM WITHDRAW     ${state}`),
    fmt(`ATM CASH WDL ${randDigits(2)}/${randDigits(2)} #${randDigits(6)}`),
  ]);
  return { description: desc, sign: 'debit' };
}

function genIncome() {
  const r = Math.random();
  if (r < 0.25) {
    const employer = rand(EMPLOYER_NAMES);
    const desc = rand([
      `${employer.padEnd(17)}PAYROLL${' '.repeat(20)}PPD ID: ${randDigits(9)}`,
      `ORIG CO NAME:${employer.padEnd(20)}CO ENTRY DESCR:PAYROLL    SEC:PPD`,
      fmt(`${employer} PAYROLL`),
    ]);
    return { description: desc, sign: 'credit' };
  }
  if (r < 0.37) {
    const name = randName();
    return { description: `Zelle payment from ${name} ${randAlpha(12)}`, sign: 'credit' };
  }
  if (r < 0.47) {
    const desc = rand([
      `BENEFIT PAYMENT  EDI PYMNTS${' '.repeat(17)}PPD ID: ${randAlpha(10)}`,
      `${rand(EMPLOYER_NAMES).padEnd(17)}DIR DEP${' '.repeat(20)}PPD ID: ${randDigits(9)}`,
    ]);
    return { description: desc, sign: 'credit' };
  }
  if (r < 0.57) {
    const desc = rand([
      'INTEREST PAYMENT',
      'Monthly Interest Paid',
      `STATEMENT CREDIT`,
      `CASH BACK REWARD`,
    ]);
    return { description: desc, sign: 'credit' };
  }
  if (r < 0.65) {
    const desc = rand([
      `${rand(['VENMO', 'CASH APP', 'PAYPAL']).padEnd(17)}CASHOUT${' '.repeat(20)}PPD ID: ${randDigits(8)}`,
      `Money Network    P2P        ${randName()} WEB ID: ${randDigits(8)}`,
    ]);
    return { description: desc, sign: 'credit' };
  }
  // Government benefits — ACH format
  if (r < 0.78) {
    const gov = rand(merchants.income.government);
    const desc = rand([
      `${gov.padEnd(17)}310 FED SAL${' '.repeat(16)}PPD ID: ${randDigits(9)}`,
      `${gov.padEnd(17)}BENEFIT PMT${' '.repeat(16)}PPD ID: ${randDigits(9)}`,
      `ORIG CO NAME:${gov.padEnd(20)}CO ENTRY DESCR:FED SAL    SEC:PPD`,
      fmt(`${gov} BENEFIT PAYMENT`),
      fmt(`${gov} 310 ${rand(['FED SAL', 'SOC SEC', 'XXVA BEN', 'XXSSI'])}`),
    ]);
    return { description: desc, sign: 'credit' };
  }
  // Gig economy payouts
  if (r < 0.88) {
    const gig = rand(merchants.income.gig);
    const rideshareDelivery = ['UBER', 'LYFT', 'DOORDASH', 'INSTACART', 'GRUBHUB'];
    const freelance = ['FIVERR', 'UPWORK', 'TOPTAL', 'ETSY', 'EBAY'];
    let desc;
    if (rideshareDelivery.includes(gig)) {
      desc = rand([
        `${gig.padEnd(17)}PAYMENTS${' '.repeat(19)}PPD ID: ${randDigits(8)}`,
        fmt(`${gig} BV PAYMENTS`),
        fmt(`${gig === 'DOORDASH' ? 'DOORDASH DASHERPAY' : gig + ' DRIVER PAY'}`),
        fmt(`${gig} PAYOUT`),
        fmt(`${gig} EARNINGS`),
      ]);
    } else {
      desc = rand([
        `${gig.padEnd(17)}PAYMENTS${' '.repeat(19)}PPD ID: ${randDigits(8)}`,
        fmt(`${gig} PAYOUT`),
        fmt(`${gig} EARNINGS`),
        fmt(`${gig} SELLER PAYMENT`),
        `ORIG CO NAME:${gig.padEnd(20)}CO ENTRY DESCR:PAYMENTS   SEC:PPD`,
      ]);
    }
    return { description: desc, sign: 'credit' };
  }
  // Refund
  const desc = rand([
    `Payment Refund: ${rand([...merchants.shopping.online, ...merchants.subscription.streaming])}`,
    `REMOTE ONLINE DEPOSIT #${' '.repeat(10)}${randInt(1, 5)}`,
    `${rand(['TRADESTATION', rand(EMPLOYER_NAMES)]).padEnd(17)}PAYMENTS${' '.repeat(19)}PPD ID: ${randDigits(8)}`,
  ]);
  return { description: desc, sign: 'credit' };
}

function genFees() {
  const fee = rand(merchants.fees.types);
  if (Math.random() < 0.3) {
    return fmt(`${fee} - ${randDigits(2)}/${randDigits(2)}`);
  }
  return fmt(fee);
}

// === MAIN ===

// Sign distribution per category — probability of [credit] prefix
// Reflects real-world: spending categories are mostly debits,
// Income is almost always credit, Transfer is bidirectional
const creditProbability = {
  'Restaurants': 0.03,
  'Groceries': 0.03,
  'Shopping': 0.07,
  'Transportation': 0.03,
  'Entertainment': 0.05,
  'Utilities': 0.03,
  'Subscription': 0.05,
  'Healthcare': 0.05,
  'Insurance': 0.02,
  'Mortgage': 0.02,
  'Rent': 0.03,
  'Travel': 0.10,
  'Education': 0.05,
  'Personal Care': 0.03,
  'Transfer': 0.50,
  'Income': 0.97,
  'Fees': 0.05,
};

const generators = {
  'Restaurants': genRestaurants,
  'Groceries': genGroceries,
  'Shopping': genShopping,
  'Transportation': genTransportation,
  'Entertainment': genEntertainment,
  'Utilities': genUtilities,
  'Subscription': genSubscription,
  'Healthcare': genHealthcare,
  'Insurance': genInsurance,
  'Mortgage': genMortgage,
  'Rent': genRent,
  'Travel': genTravel,
  'Education': genEducation,
  'Personal Care': genPersonalCare,
  'Transfer': genTransfer,
  'Income': genIncome,
  'Fees': genFees,
};

const outDir = path.join(__dirname, '..', 'data', 'training');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const rows = [];
for (const [category, generator] of Object.entries(generators)) {
  for (let i = 0; i < countArg; i++) {
    const result = generator();
    let description, prefix;
    if (typeof result === 'object' && result.description) {
      description = result.description.replace(/,/g, ' ').replace(/"/g, "'").replace(/\s+/g, ' ').trim();
      prefix = result.sign === 'credit' ? '[credit]' : '[debit]';
    } else {
      description = result.replace(/,/g, ' ').replace(/"/g, "'").replace(/\s+/g, ' ').trim();
      const isCredit = Math.random() < (creditProbability[category] || 0.03);
      prefix = isCredit ? '[credit]' : '[debit]';
    }
    if (description) {
      rows.push(`"${prefix} ${description}","${category}"`);
    }
  }
}

// Shuffle
for (let i = rows.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [rows[i], rows[j]] = [rows[j], rows[i]];
}

const csv = 'description,category\n' + rows.join('\n') + '\n';
const outPath = path.join(outDir, 'transactions-synthetic.csv');
fs.writeFileSync(outPath, csv);

console.log(`Generated ${rows.length} synthetic transactions (${countArg} per category × ${Object.keys(generators).length} categories)`);
console.log(`Output: ${outPath}`);

// Stats
const counts = {};
rows.forEach(r => {
  const cat = r.split('","')[1].replace('"', '');
  counts[cat] = (counts[cat] || 0) + 1;
});
console.log('\nPer category:');
Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([cat, cnt]) => {
  console.log(`  ${cat.padEnd(20)} ${cnt}`);
});
