// The roster the labor plan starts from.
//
// Pulled from the Staff base (Airtable), Status = Active or "To be hired -
// ASAP", on 2026-10-23. Org-chart grouping rows -- the ones whose Type is
// "Department" -- are left out; they are headings, not people.
//
// WHAT IS DELIBERATELY NOT IN HERE: anybody's pay.
//
// The Staff base holds salary history, SS numbers, I-9 attachments and
// dates of birth, and the inventory written last week called the duplicated
// copies of that the one item in Airtable with real exposure. Committing a
// third copy of compensation into a git repository -- cloned into every
// build and every session container, and kept in history for ever -- would
// be doing exactly what that document said to stop doing.
//
// So this file carries only the org facts: who is on the roster, what they
// are called, what they do, and how they are paid (hourly or salaried, not
// how much). Every figure is typed into the page and lives in D1, behind
// Access and behind BUDGET_USERS.
//
// Fields: k key, n name, t job title, d department, v division,
// pay how they are paid, ft full or part time, type employment type,
// tbh true for a post that is open rather than a person who is here.
export const ROSTER_AS_OF = '2026-10-23';
export const PEOPLE = [
  {"k": "courtney-destefano", "n": "Courtney DeStefano", "t": "eCommerce Outbound Manager", "d": "eCommerce", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "katlynn-savi", "n": "Katlynn Savi", "t": "eCommerce Manager", "d": "eCommerce", "v": "BRAND", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "amy-delpriora", "n": "Amy Delpriora", "t": "Accounting Manager", "d": "Finance", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "jeremy-defilippis", "n": "Jeremy DeFilippis", "t": "Chief Executive Officer / Chief Marketing Officer", "d": "Finance", "v": "MIXED", "pay": "guaranteed", "ft": "Full-time", "type": "partner", "tbh": false},
  {"k": "brooke-carty", "n": "Brooke Carty", "t": "Flagship Store Manager", "d": "Flagship Store", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "colin-fazio", "n": "Colin Fazio", "t": "Flagship Store Lead", "d": "Flagship Store", "v": "BRAND", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "david-bachowski", "n": "David Bachowski", "t": "Director of Jetty Retail", "d": "Flagship Store", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "italia-la-placa", "n": "Italia La Placa", "t": "Flagship Store Associate", "d": "Flagship Store", "v": "BRAND", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "kai-aceto", "n": "Kai Aceto", "t": "Flagship Store Associate", "d": "Flagship Store", "v": "BRAND", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "matthew-johnson", "n": "Matthew Johnson", "t": "Post-production Associate", "d": "Flagship Store", "v": "BRAND", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "tracy-harder", "n": "Tracy Harder", "t": "Flagship Store Lead", "d": "Flagship Store", "v": "BRAND", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "adam-klimas", "n": "Adam Klimas", "t": "Warehouse Lead", "d": "Inventory & Receiving", "v": "BRAND", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "francis-andrew-desena", "n": "Francis Andrew DeSena", "t": "Warehouse Associate", "d": "Inventory & Receiving", "v": "BRAND", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "joseph-jj-mckenna", "n": "Joseph \"JJ\" McKenna", "t": "Director of Logistics", "d": "Inventory & Receiving", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "joshua-thomas", "n": "Joshua Thomas", "t": "Warehouse Associate", "d": "Inventory & Receiving", "v": "BRAND", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "tyler-minnich", "n": "Tyler Minnich", "t": "Inventory Control Manager", "d": "Inventory & Receiving", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "drew-bowker", "n": "Drew Bowker", "t": "Jetty INK Intern", "d": "Jetty Ink Department", "v": "INK", "pay": "unpaid", "ft": "Part-time", "type": "intern", "tbh": false},
  {"k": "abigail-branstetter", "n": "Abigail Branstetter", "t": "Brand Experience Associate", "d": "Long Branch", "v": "BRAND", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "annabella-zolezzi", "n": "Annabella Zolezzi", "t": "Brand Experience Associate", "d": "Long Branch", "v": "BRAND", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "brooke-wilbanks", "n": "Brooke Wilbanks", "t": "Brand Experience Associate", "d": "Long Branch", "v": "BRAND", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "shawn-zappo", "n": "Shawn Zappo", "t": "Brand Experience Manager", "d": "Long Branch", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "trevor-eyerkuss", "n": "Trevor Eyerkuss", "t": "Brand experience lead", "d": "Long Branch", "v": "BRAND", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "arlynn-katz", "n": "Arlynn Katz", "t": "Social Media Manager", "d": "Marketing", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "attentive-mobile-inc", "n": "Attentive Mobile, Inc.", "t": "SMS Marketing", "d": "Marketing", "v": "BRAND", "pay": "", "ft": "", "type": "outsourced", "tbh": false},
  {"k": "black-sails-publications-llc-jon-coen", "n": "Black Sails Publications LLC (Jon Coen)", "t": "Content Producer", "d": "Marketing", "v": "BRAND", "pay": "", "ft": "Part-time", "type": "ic", "tbh": false},
  {"k": "katie-hehl", "n": "Katie Hehl", "t": "Digital Design Manager", "d": "Marketing", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "photography-outsourced", "n": "Photography (Outsourced)", "t": "Photography (Outsourced)", "d": "Marketing", "v": "BRAND", "pay": "", "ft": "", "type": "outsourced", "tbh": false},
  {"k": "colleen-schwarzenbach", "n": "Colleen Schwarzenbach", "t": "Sr. Director of Merchandise Planning", "d": "Merchandise Planning", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "jessica-petty", "n": "Jessica Petty", "t": "Marketing Associate/ Graphic Designer", "d": "Nonprofit (JRF)", "v": "NONPROFIT", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "kyle-gronostajski", "n": "Kyle Gronostajski", "t": "Environmental Director", "d": "Nonprofit (JRF)", "v": "NONPROFIT", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "bill-mclennan", "n": "Bill McLennan", "t": "Sr. Director of INK", "d": "Operations (INK)", "v": "INK", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "danny-morrin", "n": "Danny Morrin", "t": "Sr. Director of Design (INK)", "d": "Operations (INK)", "v": "INK", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "emma-homoki", "n": "Emma Homoki", "t": "Associate Graphic Designer", "d": "Operations (INK)", "v": "INK", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "karlee-dean", "n": "Karlee Dean", "t": "Graphic Design Manager", "d": "Operations (INK)", "v": "INK", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "john-clifford", "n": "John Clifford", "t": "Chief Brand Officer", "d": "Product Development", "v": "BRAND", "pay": "guaranteed", "ft": "Full-time", "type": "partner", "tbh": false},
  {"k": "lisa-joseph", "n": "Lisa Joseph", "t": "Director Of Product Development / Women's Brand Director", "d": "Product Development", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "erik-schilling", "n": "Erik Schilling", "t": "Quality Control Manager", "d": "Production (INK)", "v": "INK", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "hailey-klimas", "n": "Hailey Klimas", "t": "Production Associate", "d": "Production (INK)", "v": "INK", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "jake-sudol", "n": "Jake Sudol", "t": "Ink Press Operator", "d": "Production (INK)", "v": "INK", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "joseph-latini", "n": "Joseph Latini", "t": "Ink Production Associate", "d": "Production (INK)", "v": "INK", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "matthew-moranz", "n": "Matthew Moranz", "t": "INK Showroom Lead", "d": "Production (INK)", "v": "INK", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "mia-sisco", "n": "Mia Sisco", "t": "Jetty INK Production Associate", "d": "Production (INK)", "v": "INK", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "michael-d-stingone", "n": "Michael D Stingone", "t": "Production Associate", "d": "Production (INK)", "v": "INK", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "michael-eiche", "n": "Michael Eiche", "t": "Sr. Director of Production", "d": "Production (INK)", "v": "INK", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "taryn-colfax", "n": "Taryn Colfax", "t": "Ink Production Associate", "d": "Production (INK)", "v": "INK", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "troy-taylor", "n": "Troy Taylor", "t": "Ink Production Manager", "d": "Production (INK)", "v": "INK", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "agenc-private-agent-dnd-inc-eastern-ca", "n": "AgenC & Private Agent DnD Inc. (Eastern Canada)", "t": "Sales Rep", "d": "Sales (Brand)", "v": "BRAND", "pay": "", "ft": "", "type": "ic", "tbh": false},
  {"k": "cory-higgins", "n": "Cory Higgins", "t": "Chief Commercial Officer", "d": "Sales (Brand)", "v": "BRAND", "pay": "guaranteed", "ft": "Full-time", "type": "partner", "tbh": false},
  {"k": "dennis-regan-western-canada", "n": "Dennis Regan (Western Canada)", "t": "Sales Rep", "d": "Sales (Brand)", "v": "BRAND", "pay": "", "ft": "", "type": "ic", "tbh": false},
  {"k": "dustin-henry", "n": "Dustin Henry", "t": "In-house Account Manager", "d": "Sales (Brand)", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "halcyon-enterprises-inc-team-beach", "n": "Halcyon Enterprises Inc. (Team Beach)", "t": "Sales Rep", "d": "Sales (Brand)", "v": "BRAND", "pay": "", "ft": "", "type": "ic", "tbh": false},
  {"k": "jim-compton-rockies", "n": "Jim Compton (Rockies)", "t": "Sales Rep", "d": "Sales (Brand)", "v": "BRAND", "pay": "commission", "ft": "", "type": "ic", "tbh": false},
  {"k": "jordana-buchta", "n": "Jordana Buchta", "t": "In-House Account Support Lead", "d": "Sales (Brand)", "v": "BRAND", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "njp-associates-midwest", "n": "NJP Associates (Midwest)", "t": "Sales Rep", "d": "Sales (Brand)", "v": "BRAND", "pay": "", "ft": "", "type": "ic", "tbh": false},
  {"k": "paul-harvey", "n": "Paul Harvey", "t": "Sr. Director of Wholesale Sales", "d": "Sales (Brand)", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "puerto-hermina-sales-agency-pr", "n": "Puerto Hermina Sales Agency (PR)", "t": "Sales Rep", "d": "Sales (Brand)", "v": "BRAND", "pay": "", "ft": "", "type": "ic", "tbh": false},
  {"k": "sandbox-metropolis-northeast", "n": "Sandbox Metropolis (Northeast)", "t": "Sales Rep", "d": "Sales (Brand)", "v": "BRAND", "pay": "", "ft": "", "type": "ic", "tbh": false},
  {"k": "stone-sales-inc-bouchard-group", "n": "Stone Sales Inc (Bouchard Group)", "t": "Sales Rep", "d": "Sales (Brand)", "v": "BRAND", "pay": "", "ft": "", "type": "ic", "tbh": false},
  {"k": "t-l-action-agency-mink", "n": "T&L Action Agency (MINK)", "t": "Sales Rep", "d": "Sales (Brand)", "v": "BRAND", "pay": "", "ft": "", "type": "ic", "tbh": false},
  {"k": "anthony-hediger", "n": "Anthony Hediger", "t": "Sr. Director of Sales (INK)", "d": "Sales (INK)", "v": "INK", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "collin-fredrickson", "n": "Collin Fredrickson", "t": "Associate Account Manager", "d": "Sales (INK)", "v": "INK", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "dan-przygocki", "n": "Dan Przygocki", "t": "Sr. Ink Account Manager", "d": "Sales (INK)", "v": "INK", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "frank-ritacco", "n": "Frank Ritacco", "t": "INK Account Manager", "d": "Sales (INK)", "v": "INK", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "sarah-zavodsky", "n": "Sarah Zavodsky", "t": "INK Showroom Lead", "d": "Sales (INK)", "v": "INK", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "andrew-reiss", "n": "Andrew Reiss", "t": "Event Lead", "d": "Sales (Mobile)", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "joe-mangino", "n": "Joe Mangino", "t": "Sr. Director of Events", "d": "Sales (Mobile)", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "michael-hambly", "n": "Michael Hambly", "t": "Wholesale Fulfillment Lead", "d": "Wholesale", "v": "BRAND", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "nicholas-miri", "n": "Nicholas Miri", "t": "Wholesale Customer Experience Manager", "d": "Wholesale", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "accounts-payable-a-p", "n": "Accounts Payable (A/P)", "t": "Accounts Payable (A/P)", "d": "Unassigned", "v": "", "pay": "", "ft": "", "type": "w2", "tbh": true},
  {"k": "aez-sales-llc-abbey-zito", "n": "AEZ Sales, LLC (Abbey Zito)", "t": "Sales Rep", "d": "Unassigned", "v": "BRAND", "pay": "commission", "ft": "", "type": "ic", "tbh": false},
  {"k": "austin-olivares-socal", "n": "Austin Olivares (SoCal)", "t": "Sales Rep", "d": "Unassigned", "v": "BRAND", "pay": "commission", "ft": "", "type": "ic", "tbh": false},
  {"k": "board-of-directors", "n": "Board of Directors", "t": "", "d": "Unassigned", "v": "MIXED", "pay": "", "ft": "", "type": "", "tbh": false},
  {"k": "brett-hunt", "n": "Brett Hunt", "t": "Lead Screen Tech", "d": "Unassigned", "v": "INK", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "brian-eskelson-pnw", "n": "Brian Eskelson (PNW)", "t": "Sales Rep", "d": "Unassigned", "v": "BRAND", "pay": "", "ft": "", "type": "ic", "tbh": false},
  {"k": "craig-clifford", "n": "Craig Clifford", "t": "Partner", "d": "Unassigned", "v": "MIXED", "pay": "", "ft": "", "type": "partner", "tbh": false},
  {"k": "datmos-fka-the-zaneray-group", "n": "Datmos FKA The ZaneRay Group", "t": "Website Agency", "d": "Unassigned", "v": "BRAND", "pay": "", "ft": "", "type": "outsourced", "tbh": false},
  {"k": "fresh-fish-llc-beth-davis", "n": "Fresh Fish LLC (Beth Davis)", "t": "Graphic Designer (Freelance)", "d": "Unassigned", "v": "INK", "pay": "", "ft": "", "type": "ic", "tbh": false},
  {"k": "graphic-designer", "n": "Graphic Designer", "t": "Graphic Designer", "d": "Unassigned", "v": "", "pay": "", "ft": "", "type": "w2", "tbh": true},
  {"k": "hoff", "n": "HOFF", "t": "Hoff", "d": "Unassigned", "v": "", "pay": "", "ft": "", "type": "outsourced", "tbh": false},
  {"k": "ink-logistics-associate", "n": "Ink Logistics Associate", "t": "Ink Logistics Associate", "d": "Unassigned", "v": "", "pay": "", "ft": "", "type": "w2", "tbh": true},
  {"k": "ink-sales-associate", "n": "Ink Sales Associate", "t": "Ink Sales Associate", "d": "Unassigned", "v": "", "pay": "", "ft": "", "type": "w2", "tbh": true},
  {"k": "isaac-mclennan", "n": "Isaac McLennan", "t": "Jetty Ink Production Assisstant", "d": "Unassigned", "v": "INK", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "isabel-anderson", "n": "Isabel Anderson", "t": "Flagship Store Associate", "d": "Unassigned", "v": "BRAND", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "llm-sales-llc-tola", "n": "LLM Sales LLC (TOLA)", "t": "Sales Rep", "d": "Unassigned", "v": "BRAND", "pay": "commission", "ft": "", "type": "ic", "tbh": false},
  {"k": "luke-pacchia", "n": "Luke Pacchia", "t": "eComm Customer Experience Manager", "d": "Unassigned", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "maya-paco", "n": "Maya Paco", "t": "Lead Brand Experience", "d": "Unassigned", "v": "BRAND", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "okendo", "n": "Okendo", "t": "Okendo", "d": "Unassigned", "v": "", "pay": "", "ft": "", "type": "outsourced", "tbh": false},
  {"k": "paul-clifford", "n": "Paul Clifford", "t": "Partner", "d": "Unassigned", "v": "MIXED", "pay": "", "ft": "", "type": "partner", "tbh": false},
  {"k": "raul-pacheco", "n": "Raul Pacheco", "t": "Brand Experience Associate", "d": "Unassigned", "v": "BRAND", "pay": "hourly", "ft": "Part-time", "type": "w2", "tbh": false},
  {"k": "schulte-sales-inc-socal", "n": "Schulte Sales Inc. (SoCal)", "t": "Sales Rep", "d": "Unassigned", "v": "BRAND", "pay": "commission", "ft": "", "type": "ic", "tbh": false},
  {"k": "shane-biroc", "n": "Shane Biroc", "t": "Warehouse Associate", "d": "Unassigned", "v": "BRAND", "pay": "hourly", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "skeleton-crew-sales-service-norcal", "n": "Skeleton Crew Sales & Service (NorCal)", "t": "Sales Rep", "d": "Unassigned", "v": "BRAND", "pay": "", "ft": "", "type": "ic", "tbh": false},
  {"k": "sunnyside-collective", "n": "Sunnyside Collective", "t": "Marketing Agency", "d": "Unassigned", "v": "", "pay": "", "ft": "", "type": "outsourced", "tbh": false},
  {"k": "taylor-caruso", "n": "Taylor Caruso", "t": "Associate Designer", "d": "Unassigned", "v": "BRAND", "pay": "salary", "ft": "Full-time", "type": "w2", "tbh": false},
  {"k": "the-briones-group-inc-western-great-la", "n": "The Briones Group Inc. (Western Great Lakes)", "t": "Sales Rep", "d": "Unassigned", "v": "BRAND", "pay": "", "ft": "", "type": "ic", "tbh": false},
  {"k": "video-outsourced", "n": "Video (Outsourced)", "t": "Video (Outsourced)", "d": "Unassigned", "v": "", "pay": "", "ft": "", "type": "outsourced", "tbh": false}
];
