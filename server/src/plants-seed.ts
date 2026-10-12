// Global plant catalog. Timings are typical averages; "sow" windows assume SW Ohio
// (USDA zone 6b, last frost ~Apr 20, first frost ~Oct 20). Maturity counts from
// direct sow, or from transplant where the sow note says "transplant".
export interface PlantSeed {
  name: string; glyph: string; color: string;
  germ: number; maturity: number; water: number; spacing: number;
  sow: string; notes: string;
}

const p = (name: string, glyph: string, color: string, germ: number, maturity: number, water: number, spacing: number, sow: string, notes = ''): PlantSeed =>
  ({ name, glyph, color, germ, maturity, water, spacing, sow, notes });

export const PLANT_SEED: PlantSeed[] = [
  p('Tomato', 'TO', '#e5484d', 7, 75, 2, 24, 'Start indoors early Mar; transplant early-mid May', 'Stake or cage; water at the base'),
  p('Cherry tomato', 'CT', '#f2555a', 7, 65, 2, 24, 'Start indoors early Mar; transplant early-mid May'),
  p('Bell pepper', 'PE', '#46a758', 10, 75, 3, 18, 'Start indoors late Feb; transplant mid-late May'),
  p('Hot pepper', 'HP', '#f76b15', 12, 80, 3, 18, 'Start indoors late Feb; transplant mid-late May'),
  p('Eggplant', 'EG', '#8e4ec6', 10, 80, 3, 24, 'Start indoors late Feb; transplant late May'),
  p('Zucchini', 'ZU', '#30a46c', 7, 50, 3, 36, 'Direct sow mid May-Jul', 'Watch for squash vine borer'),
  p('Summer squash', 'SQ', '#ffc53d', 7, 55, 3, 36, 'Direct sow mid May-Jul'),
  p('Winter squash', 'WS', '#d6a35c', 8, 95, 3, 48, 'Direct sow late May-mid Jun', 'Stores for months; great prep crop'),
  p('Pumpkin', 'PK', '#ef8f34', 8, 100, 3, 60, 'Direct sow late May-mid Jun'),
  p('Cucumber', 'CU', '#5bb98c', 7, 55, 2, 18, 'Direct sow mid May-Jul', 'Trellis to save space'),
  p('Watermelon', 'WM', '#e93d82', 8, 85, 3, 48, 'Direct sow late May-early Jun'),
  p('Cantaloupe', 'CA', '#f5a35b', 8, 85, 3, 36, 'Direct sow late May-early Jun'),
  p('Green bean (bush)', 'BB', '#3e9b4f', 8, 55, 3, 4, 'Direct sow mid May-late Jul', 'Succession sow every 3 weeks'),
  p('Pole bean', 'PB', '#2f7c3e', 8, 65, 3, 6, 'Direct sow mid May-Jul'),
  p('Dry bean', 'DB', '#a07553', 8, 95, 4, 4, 'Direct sow mid May-early Jun', 'Shelf-stable protein'),
  p('Pea', 'PS', '#86d39a', 10, 60, 3, 2, 'Direct sow mid Mar-mid Apr; again Aug', 'Cool season'),
  p('Sweet corn', 'CO', '#f0d84a', 7, 80, 3, 12, 'Direct sow mid May-Jun', 'Plant in blocks for pollination'),
  p('Potato', 'PO', '#b08968', 14, 100, 4, 12, 'Plant seed potatoes late Mar-Apr', 'Hill as they grow; stores well'),
  p('Sweet potato', 'SP', '#c2410c', 10, 110, 4, 12, 'Plant slips late May-early Jun'),
  p('Onion', 'ON', '#e2c290', 10, 100, 4, 4, 'Sets/transplants late Mar-Apr'),
  p('Garlic', 'GA', '#e8e2d0', 21, 240, 5, 6, 'Plant cloves Oct-early Nov; harvest Jul', 'Overwinters'),
  p('Carrot', 'CR', '#f97316', 14, 70, 2, 2, 'Direct sow Apr-Jul', 'Keep soil moist until germination'),
  p('Beet', 'BE', '#9d174d', 8, 55, 3, 3, 'Direct sow Apr-Jul'),
  p('Radish', 'RA', '#ec4899', 5, 28, 2, 2, 'Direct sow Mar-May; Aug-Sep'),
  p('Turnip', 'TU', '#c084fc', 6, 50, 3, 4, 'Direct sow Mar-Apr; Aug'),
  p('Lettuce', 'LE', '#a3e635', 7, 45, 2, 8, 'Direct sow Mar-May; Aug-Sep', 'Bolts in summer heat'),
  p('Spinach', 'SN', '#15803d', 8, 40, 2, 4, 'Direct sow Mar-Apr; Sep'),
  p('Kale', 'KA', '#166534', 7, 55, 3, 12, 'Direct sow/transplant Mar-Apr; Jul-Aug', 'Frost improves flavor'),
  p('Swiss chard', 'SC', '#be123c', 7, 55, 3, 9, 'Direct sow Apr-Jul'),
  p('Cabbage', 'CB', '#65a30d', 7, 75, 3, 18, 'Transplant Apr; again Jul'),
  p('Broccoli', 'BR', '#4d7c0f', 7, 65, 3, 18, 'Transplant Apr; again late Jul'),
  p('Cauliflower', 'CF', '#f5f5f4', 7, 70, 3, 18, 'Transplant Apr; again late Jul'),
  p('Basil', 'BA', '#22c55e', 7, 60, 2, 10, 'Transplant mid May', 'Pinch flowers'),
  p('Parsley', 'PA', '#16a34a', 21, 75, 3, 8, 'Start indoors Mar; transplant Apr-May'),
  p('Cilantro', 'CI', '#4ade80', 10, 50, 3, 6, 'Direct sow Apr; Aug-Sep', 'Bolts in heat'),
  p('Dill', 'DI', '#a7f3d0', 14, 60, 3, 12, 'Direct sow Apr-Jun'),
  p('Chives', 'CH', '#84cc16', 14, 80, 4, 8, 'Start Mar; perennial'),
  p('Mint', 'MI', '#10b981', 14, 90, 3, 18, 'Transplant Apr-May', 'Spreads aggressively; use a container'),
  p('Strawberry', 'ST', '#dc2626', 21, 365, 3, 12, 'Plant crowns Apr', 'Perennial; fruits year 2'),
  p('Sunflower', 'SU', '#facc15', 10, 80, 4, 18, 'Direct sow May-Jun'),
  p('Marigold', 'MA', '#fb923c', 6, 50, 4, 8, 'Transplant mid May', 'Companion / pest deterrent'),
];
