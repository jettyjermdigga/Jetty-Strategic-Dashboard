// Who can earn Boxy Bucks.
//
// The Staff base, view "Employee Headcount" -- Active, and Type is Employee
// (W2) or Operating Partner -- read on 2026-10-26. That view is already the
// company's own answer to "who is on the payroll", so the leaderboard uses
// it rather than inventing a second list that would drift from it.
//
// Names and org facts only. The view also carries personal email addresses
// -- most of this roster signs in with gmail or icloud, not a Jetty address
// -- and none of this needs them: nobody here signs in, they are the
// subjects of the leaderboard rather than its users. Sixty-three personal
// addresses in a git repository is a thing to avoid having done, not a
// thing to undo later.
//
// Fields: k key, n name, t job title, d department, v division, loc where
// they are based.
export const ROSTER_AS_OF = '2026-10-26';
export const STAFF = [
  {"k": "troy-taylor", "n": "Troy Taylor", "t": "Ink Production Manager", "d": "Production (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "paul-harvey", "n": "Paul Harvey", "t": "Sr. Director of Wholesale Sales", "d": "Sales (Brand)", "v": "BRAND", "loc": "Work from Home"},
  {"k": "kyle-gronostajski", "n": "Kyle Gronostajski", "t": "Environmental Director", "d": "Nonprofit (JRF)", "v": "NONPROFIT", "loc": "176 E Bay"},
  {"k": "michael-hambly", "n": "Michael Hambly", "t": "Wholesale Fulfillment Lead", "d": "Wholesale", "v": "BRAND", "loc": "700 S Main"},
  {"k": "isaac-mclennan", "n": "Isaac McLennan", "t": "Jetty Ink Production Assisstant", "d": "Unassigned", "v": "INK", "loc": "509 N Main"},
  {"k": "maya-paco", "n": "Maya Paco", "t": "Lead Brand Experience", "d": "Unassigned", "v": "BRAND", "loc": "Long Branch"},
  {"k": "annabella-zolezzi", "n": "Annabella Zolezzi", "t": "Brand Experience Associate", "d": "Long Branch", "v": "BRAND", "loc": "Long Branch"},
  {"k": "taryn-colfax", "n": "Taryn Colfax", "t": "Ink Production Associate", "d": "Production (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "joshua-thomas", "n": "Joshua Thomas", "t": "Warehouse Associate", "d": "Inventory & Receiving", "v": "BRAND", "loc": "700 S Main"},
  {"k": "abigail-branstetter", "n": "Abigail Branstetter", "t": "Brand Experience Associate", "d": "Long Branch", "v": "BRAND", "loc": "Long Branch"},
  {"k": "john-clifford", "n": "John Clifford", "t": "Chief Brand Officer", "d": "Product Development", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "trevor-eyerkuss", "n": "Trevor Eyerkuss", "t": "Brand experience lead", "d": "Long Branch", "v": "BRAND", "loc": "Long Branch"},
  {"k": "cory-higgins", "n": "Cory Higgins", "t": "Chief Commercial Officer", "d": "Sales (Brand)", "v": "BRAND", "loc": "700 S Main"},
  {"k": "jessica-petty", "n": "Jessica Petty", "t": "Marketing Associate/ Graphic Designer", "d": "Nonprofit (JRF)", "v": "NONPROFIT", "loc": "176 E Bay"},
  {"k": "david-bachowski", "n": "David Bachowski", "t": "Director of Jetty Retail", "d": "Flagship Store", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "dan-przygocki", "n": "Dan Przygocki", "t": "Sr. Ink Account Manager", "d": "Sales (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "luke-pacchia", "n": "Luke Pacchia", "t": "eComm Customer Experience Manager", "d": "Unassigned", "v": "BRAND", "loc": "700 S Main"},
  {"k": "dustin-henry", "n": "Dustin Henry", "t": "In-house Account Manager", "d": "Sales (Brand)", "v": "BRAND", "loc": "700 S Main"},
  {"k": "raul-pacheco", "n": "Raul Pacheco", "t": "Brand Experience Associate", "d": "Unassigned", "v": "BRAND", "loc": "Long Branch"},
  {"k": "katlynn-savi", "n": "Katlynn Savi", "t": "eCommerce Manager", "d": "eCommerce", "v": "BRAND", "loc": "700 S Main"},
  {"k": "sarah-zavodsky", "n": "Sarah Zavodsky", "t": "INK Showroom Lead", "d": "Sales (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "danny-morrin", "n": "Danny Morrin", "t": "Sr. Director of Design (INK)", "d": "Operations (INK)", "v": "INK", "loc": "Work from Home"},
  {"k": "jeremy-defilippis", "n": "Jeremy DeFilippis", "t": "Chief Executive Officer / Chief Marketing Officer", "d": "Finance", "v": "MIXED", "loc": "176 E Bay"},
  {"k": "bill-mclennan", "n": "Bill McLennan", "t": "Sr. Director of INK", "d": "Operations (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "emma-homoki", "n": "Emma Homoki", "t": "Associate Graphic Designer", "d": "Operations (INK)", "v": "INK", "loc": "Work from Home"},
  {"k": "courtney-destefano", "n": "Courtney DeStefano", "t": "eCommerce Outbound Manager", "d": "eCommerce", "v": "BRAND", "loc": "700 S Main"},
  {"k": "michael-eiche", "n": "Michael Eiche", "t": "Sr. Director of Production", "d": "Production (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "michael-d-stingone", "n": "Michael D Stingone", "t": "Production Associate", "d": "Production (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "brooke-wilbanks", "n": "Brooke Wilbanks", "t": "Brand Experience Associate", "d": "Long Branch", "v": "BRAND", "loc": "Long Branch"},
  {"k": "hailey-klimas", "n": "Hailey Klimas", "t": "Production Associate", "d": "Production (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "italia-la-placa", "n": "Italia La Placa", "t": "Flagship Store Associate", "d": "Flagship Store", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "jake-sudol", "n": "Jake Sudol", "t": "Ink Press Operator", "d": "Production (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "anthony-hediger", "n": "Anthony Hediger", "t": "Sr. Director of Sales (INK)", "d": "Sales (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "francis-andrew-desena", "n": "Francis Andrew DeSena", "t": "Warehouse Associate", "d": "Inventory & Receiving", "v": "BRAND", "loc": "700 S Main"},
  {"k": "arlynn-katz", "n": "Arlynn Katz", "t": "Social Media Manager", "d": "Marketing", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "taylor-caruso", "n": "Taylor Caruso", "t": "Associate Designer", "d": "Unassigned", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "joseph-jj-mckenna", "n": "Joseph \"JJ\" McKenna", "t": "Director of Logistics", "d": "Inventory & Receiving", "v": "BRAND", "loc": "700 S Main"},
  {"k": "isabel-anderson", "n": "Isabel Anderson", "t": "Flagship Store Associate", "d": "Unassigned", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "colin-fazio", "n": "Colin Fazio", "t": "Flagship Store Lead", "d": "Flagship Store", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "joseph-latini", "n": "Joseph Latini", "t": "Ink Production Associate", "d": "Production (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "shane-biroc", "n": "Shane Biroc", "t": "Warehouse Associate", "d": "Unassigned", "v": "BRAND", "loc": "700 S Main"},
  {"k": "matthew-johnson", "n": "Matthew Johnson", "t": "Post-production Associate", "d": "Flagship Store", "v": "BRAND", "loc": "700 S Main"},
  {"k": "andrew-reiss", "n": "Andrew Reiss", "t": "Event Lead", "d": "Sales (Mobile)", "v": "BRAND", "loc": "700 S Main"},
  {"k": "shawn-zappo", "n": "Shawn Zappo", "t": "Brand Experience Manager", "d": "Long Branch", "v": "BRAND", "loc": "Long Branch"},
  {"k": "amy-delpriora", "n": "Amy Delpriora", "t": "Accounting Manager", "d": "Finance", "v": "BRAND", "loc": "Work from Home"},
  {"k": "karlee-dean", "n": "Karlee Dean", "t": "Graphic Design Manager", "d": "Operations (INK)", "v": "INK", "loc": "Work from Home"},
  {"k": "adam-klimas", "n": "Adam Klimas", "t": "Warehouse Lead", "d": "Inventory & Receiving", "v": "BRAND", "loc": "700 S Main"},
  {"k": "joe-mangino", "n": "Joe Mangino", "t": "Sr. Director of Events", "d": "Sales (Mobile)", "v": "BRAND", "loc": "700 S Main"},
  {"k": "collin-fredrickson", "n": "Collin Fredrickson", "t": "Associate Account Manager", "d": "Sales (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "tyler-minnich", "n": "Tyler Minnich", "t": "Inventory Control Manager", "d": "Inventory & Receiving", "v": "BRAND", "loc": "700 S Main"},
  {"k": "tracy-harder", "n": "Tracy Harder", "t": "Flagship Store Lead", "d": "Flagship Store", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "mia-sisco", "n": "Mia Sisco", "t": "Jetty INK Production Associate", "d": "Production (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "katie-hehl", "n": "Katie Hehl", "t": "Digital Design Manager", "d": "Marketing", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "colleen-schwarzenbach", "n": "Colleen Schwarzenbach", "t": "Sr. Director of Merchandise Planning", "d": "Merchandise Planning", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "matthew-moranz", "n": "Matthew Moranz", "t": "INK Showroom Lead", "d": "Production (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "kai-aceto", "n": "Kai Aceto", "t": "Flagship Store Associate", "d": "Flagship Store", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "brooke-carty", "n": "Brooke Carty", "t": "Flagship Store Manager", "d": "Flagship Store", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "nicholas-miri", "n": "Nicholas Miri", "t": "Wholesale Customer Experience Manager", "d": "Wholesale", "v": "BRAND", "loc": "700 S Main"},
  {"k": "frank-ritacco", "n": "Frank Ritacco", "t": "INK Account Manager", "d": "Sales (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "jordana-buchta", "n": "Jordana Buchta", "t": "In-House Account Support Lead", "d": "Sales (Brand)", "v": "BRAND", "loc": "700 S Main"},
  {"k": "lisa-joseph", "n": "Lisa Joseph", "t": "Director Of Product Development / Women's Brand Director", "d": "Product Development", "v": "BRAND", "loc": "176 E Bay"},
  {"k": "erik-schilling", "n": "Erik Schilling", "t": "Quality Control Manager", "d": "Production (INK)", "v": "INK", "loc": "509 N Main"},
  {"k": "brett-hunt", "n": "Brett Hunt", "t": "Lead Screen Tech", "d": "Unassigned", "v": "INK", "loc": "509 N Main"}
];
