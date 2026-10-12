/**
 * Common prep staples for quick-add suggestions: "black bea" → Black beans, 15 oz can.
 * Sizes are the most common US retail package; kcal is for the whole package (from typical
 * labels, rounded), so days-of-food works without scanning. shelfMonths is a typical best-by
 * window from purchase, shown as a hint only, never filled in, since the printed date wins.
 */
export interface Staple {
  name: string;
  unit: string;
  category: string;
  kcal?: number;
  shelfMonths?: number;
  /** Extra words people type: "garbanzo", "tp". */
  aka?: string;
}

const food = (name: string, unit: string, kcal: number, shelfMonths: number, aka?: string): Staple => ({ name, unit, category: 'food', kcal, shelfMonths, aka });
const kind = (category: string) => (name: string, unit: string, shelfMonths?: number, aka?: string): Staple => ({ name, unit, category, shelfMonths, aka });
const water = kind('water'), med = kind('medical'), hyg = kind('hygiene'), power = kind('power'), tool = kind('tools'), comms = kind('comms'), garden = kind('garden');

export const STAPLES: Staple[] = [
  // ---- canned beans & legumes
  food('Black beans, 15 oz can', 'can', 385, 30),
  food('Pinto beans, 15 oz can', 'can', 385, 30),
  food('Kidney beans, 15 oz can', 'can', 385, 30, 'red'),
  food('Chickpeas, 15 oz can', 'can', 420, 30, 'garbanzo'),
  food('Great northern beans, 15 oz can', 'can', 350, 30, 'white'),
  food('Black-eyed peas, 15 oz can', 'can', 385, 30),
  food('Baked beans, 28 oz can', 'can', 910, 30),
  food('Refried beans, 16 oz can', 'can', 420, 30),
  // ---- canned vegetables & tomatoes
  food('Sweet corn, 15.25 oz can', 'can', 210, 30),
  food('Green beans, 14.5 oz can', 'can', 70, 30),
  food('Sweet peas, 15 oz can', 'can', 210, 30),
  food('Mixed vegetables, 15 oz can', 'can', 140, 30),
  food('Sliced carrots, 14.5 oz can', 'can', 105, 30),
  food('Sliced potatoes, 15 oz can', 'can', 210, 30),
  food('Spinach, 13.5 oz can', 'can', 90, 30),
  food('Pumpkin puree, 15 oz can', 'can', 150, 30),
  food('Diced tomatoes, 14.5 oz can', 'can', 90, 18),
  food('Crushed tomatoes, 28 oz can', 'can', 245, 18),
  food('Tomato sauce, 15 oz can', 'can', 140, 18),
  food('Tomato paste, 6 oz can', 'can', 150, 18),
  food('Pasta sauce, 24 oz jar', 'jar', 380, 18, 'spaghetti marinara'),
  // ---- canned meat & fish
  food('Chunk light tuna, 5 oz can', 'can', 100, 36),
  food('Chunk chicken breast, 12.5 oz can', 'can', 315, 36),
  food('Pink salmon, 14.75 oz can', 'can', 605, 36),
  food('Sardines in oil, 3.75 oz can', 'can', 190, 36),
  food('Spam, 12 oz can', 'can', 1080, 36, 'luncheon meat'),
  food('Corned beef, 12 oz can', 'can', 780, 36),
  food('Vienna sausages, 4.6 oz can', 'can', 270, 36),
  food('Beef stew, 20 oz can', 'can', 440, 30),
  food('Chili with beans, 15 oz can', 'can', 520, 30),
  // ---- soups & meals
  food('Chicken noodle soup, 10.75 oz can', 'can', 150, 24, 'condensed'),
  food('Cream of mushroom soup, 10.5 oz can', 'can', 250, 24, 'condensed'),
  food('Chunky soup, 18.8 oz can', 'can', 280, 24),
  food('Ravioli, 15 oz can', 'can', 460, 24),
  food('Mac & cheese, 7.25 oz box', 'box', 750, 18, 'macaroni'),
  food('Ramen noodles, 3 oz pack', 'pack', 380, 12),
  food('Freeze-dried meal, 2-serving pouch', 'pouch', 550, 300, 'mountain house'),
  food('MRE (meal ready to eat)', 'ea', 1250, 60),
  food('Emergency ration bar, 3600 kcal', 'pack', 3600, 60, 'datrex sos'),
  // ---- canned fruit & dairy
  food('Sliced peaches, 15 oz can', 'can', 210, 24),
  food('Fruit cocktail, 15 oz can', 'can', 245, 24),
  food('Pineapple chunks, 20 oz can', 'can', 300, 24),
  food('Mandarin oranges, 15 oz can', 'can', 280, 24),
  food('Applesauce, 24 oz jar', 'jar', 300, 18),
  food('Evaporated milk, 12 oz can', 'can', 470, 18),
  food('Sweetened condensed milk, 14 oz can', 'can', 1300, 24),
  food('Coconut milk, 13.5 oz can', 'can', 790, 24),
  food('Nonfat dry milk, 25.6 oz box', 'box', 2630, 18, 'powdered'),
  // ---- grains & pasta
  food('White rice, 20 lb bag', 'bag', 32600, 120, 'long grain'),
  food('White rice, 5 lb bag', 'bag', 8165, 120, 'long grain'),
  food('White rice, 2 lb bag', 'bag', 3270, 120, 'long grain'),
  food('Brown rice, 2 lb bag', 'bag', 3270, 12),
  food('Spaghetti, 1 lb box', 'box', 1600, 24, 'pasta'),
  food('Elbow macaroni, 1 lb box', 'box', 1600, 24, 'pasta'),
  food('Penne, 1 lb box', 'box', 1600, 24, 'pasta'),
  food('Egg noodles, 12 oz bag', 'bag', 1260, 18, 'pasta'),
  food('Rolled oats, 42 oz canister', 'ea', 4500, 24, 'oatmeal old fashioned'),
  food('Quick oats, 18 oz canister', 'ea', 1950, 24, 'oatmeal'),
  food('All-purpose flour, 5 lb bag', 'bag', 8250, 12),
  food('Cornmeal, 2 lb bag', 'bag', 3290, 12),
  food('Instant mashed potatoes, 13.75 oz box', 'box', 1365, 18),
  food('Saltine crackers, 16 oz box', 'box', 1950, 9),
  food('Cereal, 18 oz box', 'box', 1830, 9),
  food('Granola bars, box of 12', 'box', 2280, 9),
  // ---- dry beans
  food('Dried pinto beans, 2 lb bag', 'bag', 3150, 60),
  food('Dried black beans, 2 lb bag', 'bag', 3080, 60),
  food('Dried lentils, 1 lb bag', 'bag', 1600, 60),
  // ---- fats, sweeteners, spreads
  food('Peanut butter, 16 oz jar', 'jar', 2660, 18),
  food('Peanut butter, 40 oz jar', 'jar', 6650, 18),
  food('Vegetable oil, 48 oz bottle', 'bottle', 11520, 18, 'canola'),
  food('Olive oil, 17 oz bottle', 'bottle', 4080, 18),
  food('Shortening, 48 oz can', 'can', 12000, 24, 'crisco'),
  food('Granulated sugar, 4 lb bag', 'bag', 7020, 120),
  food('Brown sugar, 2 lb bag', 'bag', 3400, 24),
  food('Honey, 12 oz bottle', 'bottle', 1030, 120),
  food('Salt, 26 oz canister', 'ea', 0, 120),
  // ---- snacks & protein
  food('Mixed nuts, 16 oz can', 'can', 2720, 12),
  food('Almonds, 16 oz bag', 'bag', 2610, 12),
  food('Raisins, 20 oz canister', 'ea', 1700, 12),
  food('Trail mix, 16 oz bag', 'bag', 2400, 9),
  food('Beef jerky, 3.25 oz bag', 'bag', 260, 12),
  food('Ground coffee, 30.5 oz canister', 'ea', 0, 18),
  food('Tea bags, box of 100', 'box', 0, 24),
  food('Electrolyte drink mix, box of 16', 'box', 0, 24, 'gatorade liquid iv'),
  // ---- water
  water('Bottled water, 24-pack 16.9 oz', 'pack', 24),
  water('Drinking water, 1 gal jug', 'gal', 12),
  water('Spring water, 5 gal jug', 'ea', 24),
  water('Water purification tablets, 50 ct', 'pack', 48, 'aquatabs chlorine dioxide'),
  water('Water filter (Sawyer Squeeze)', 'ea', undefined, 'lifestraw'),
  water('Unscented bleach, 121 oz', 'bottle', 12, 'chlorine disinfect'),
  // ---- medical
  med('Ibuprofen 200 mg, 100 ct', 'bottle', 36, 'advil motrin'),
  med('Acetaminophen 500 mg, 100 ct', 'bottle', 36, 'tylenol'),
  med('Aspirin 81 mg, 120 ct', 'bottle', 36),
  med('Diphenhydramine 25 mg, 24 ct', 'box', 36, 'benadryl allergy'),
  med('Loratadine 10 mg, 30 ct', 'box', 36, 'claritin allergy'),
  med('Loperamide 2 mg, 24 ct', 'box', 36, 'imodium diarrhea'),
  med('Antacid tablets, 150 ct', 'bottle', 36, 'tums'),
  med('Oral rehydration salts, 10 packets', 'box', 36, 'ors'),
  med('Hydrocortisone cream 1%, 1 oz', 'ea', 24),
  med('Triple antibiotic ointment, 1 oz', 'ea', 24, 'neosporin'),
  med('Adhesive bandages, 100 ct', 'box', 60, 'band-aid bandaid'),
  med('Gauze pads 4x4, 25 ct', 'box', 60),
  med('Elastic bandage, 3 in', 'ea', undefined, 'ace wrap'),
  med('Medical tape, 1 in roll', 'roll'),
  med('Nitrile gloves, 100 ct', 'box', 60),
  med('N95 masks, 20 ct', 'box', 60, 'respirator'),
  med('Potassium iodide 130 mg, 14 ct', 'box', 84, 'iosat ki'),
  med('Isopropyl alcohol 70%, 16 oz', 'bottle', 36, 'rubbing'),
  med('Hydrogen peroxide 3%, 32 oz', 'bottle', 24),
  med('Hand sanitizer, 8 oz', 'bottle', 36),
  med('First aid kit', 'ea'),
  med('Tourniquet (CAT)', 'ea', undefined, 'ifak'),
  med('Digital thermometer', 'ea'),
  // ---- hygiene
  hyg('Toilet paper, 12 roll pack', 'pack', undefined, 'tp'),
  hyg('Paper towels, 6 roll pack', 'pack'),
  hyg('Bar soap', 'ea'),
  hyg('Toothpaste, 4 oz tube', 'ea', 24),
  hyg('Toothbrush', 'ea'),
  hyg('Shampoo, 12 oz', 'bottle'),
  hyg('Deodorant', 'ea'),
  hyg('Feminine pads', 'pack'),
  hyg('Tampons', 'box'),
  hyg('Baby wipes, 72 ct', 'pack'),
  hyg('Diapers', 'pack'),
  hyg('Dish soap, 19 oz', 'bottle'),
  hyg('Trash bags 13 gal, 40 ct', 'box'),
  hyg('Contractor bags 42 gal, 20 ct', 'box'),
  // ---- power & light
  power('AA batteries, 24 pack', 'pack', 120, 'double a'),
  power('AAA batteries, 24 pack', 'pack', 120, 'triple a'),
  power('D batteries, 8 pack', 'pack', 120),
  power('C batteries, 8 pack', 'pack', 120),
  power('9V batteries, 4 pack', 'pack', 60),
  power('CR123A batteries, 6 pack', 'pack', 120),
  power('18650 rechargeable battery', 'ea'),
  power('Propane cylinder, 1 lb', 'ea'),
  power('Propane tank, 20 lb', 'ea'),
  power('Gasoline, 5 gal can', 'ea', 6, 'fuel'),
  power('Fuel stabilizer, 8 oz', 'bottle', 24, 'sta-bil'),
  power('Candles', 'ea'),
  power('Lantern (LED)', 'ea'),
  // ---- tools
  tool('Flashlight (LED)', 'ea'),
  tool('Headlamp', 'ea'),
  tool('Duct tape', 'roll'),
  tool('Paracord, 100 ft', 'ea', undefined, '550'),
  tool('Strike-anywhere matches, 250 ct', 'box'),
  tool('Lighter', 'ea', undefined, 'bic'),
  tool('Multi-tool', 'ea', undefined, 'leatherman'),
  tool('Work gloves', 'pack'),
  tool('Tarp, 8x10 ft', 'ea'),
  tool('Zip ties, 100 ct', 'pack'),
  tool('Manual can opener', 'ea'),
  tool('Fire extinguisher', 'ea'),
  // ---- comms
  comms('NOAA weather radio', 'ea', undefined, 'hand crank'),
  comms('FRS/GMRS radios, 2 pack', 'pack', undefined, 'walkie talkie'),
  comms('Meshtastic node', 'ea', undefined, 'lora heltec'),
  // ---- garden
  garden('Vegetable seed packet', 'pack', 24),
  garden('Potting soil, 1 cu ft', 'bag'),
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
const INDEX = STAPLES.map((s) => ({ s, words: norm(`${s.name} ${s.aka ?? ''}`).split(' ') }));

/**
 * Every typed word must start some word of the staple ("black bea" → Black beans),
 * ranked by where the first word matches so "beans" doesn't bury "black beans".
 */
export function searchStaples(q: string, limit = 6, prefer?: string): Staple[] {
  const terms = norm(q).split(' ').filter(Boolean);
  if (!terms.length || norm(q).length < 2) return [];
  return INDEX
    .map(({ s, words }) => {
      let score = 0;
      for (const t of terms) {
        const i = words.findIndex((w) => w.startsWith(t));
        if (i < 0) return null;
        score += i;
      }
      // Inside a section (e.g. medical), that section's items come first.
      return { s, score: score + (prefer && s.category !== prefer ? 100 : 0) };
    })
    .filter((x): x is { s: Staple; score: number } => x != null)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((x) => x.s);
}

/** Quick picks for an empty section: the first few staples of that category. */
export const staplesFor = (category: string, n = 8) => STAPLES.filter((s) => s.category === category).slice(0, n);

export const shelfLabel = (m?: number) => (m == null ? '' : m >= 24 ? `~${Math.round(m / 12)} yr` : `~${m} mo`);
