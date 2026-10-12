export type Role = 'owner' | 'member' | 'viewer';
export type Tier = 'expired' | 'soon' | 'upcoming' | 'ok' | 'none';

export interface Me {
  user: { id: number; email: string; name: string; isAdmin: boolean };
  households: { id: number; name: string; role: Role }[];
  active: { id: number; name: string; role: Role } | null;
  armoryVisible: boolean;
  /** Links the active household has with households on other servers. */
  links: number;
  features: { router: boolean; photoImport: boolean; mesh: boolean; barcodeProducts: number; email: boolean; links: boolean };
  instance: { node: string; role: 'primary' | 'standby'; active: boolean; promoted: boolean; peerActive: boolean; lastSyncAt: number | null; lastSyncError: string | null };
}

export interface Item {
  id: number; name: string; category: string; qty: number; unit: string; location: string;
  barcode: string | null; expires_on: string | null; opened_on: string | null; min_qty: number | null;
  kcal_per_unit: number | null; notes: string; updated_at: number; tier: Tier;
}

export interface NewItem {
  name: string; category: string; qty: number; unit: string; location: string;
  barcode?: string | null; expires_on?: string | null; min_qty?: number | null; kcal_per_unit?: number | null; notes?: string;
}

export interface Plant { id: number; household_id: number | null; name: string; glyph: string; color: string; days_to_germ: number; days_to_maturity: number; water_every_days: number; spacing_in: number; sow: string; notes: string }
export interface Garden { id: number; name: string; rows: number; cols: number; cell_size_ft: number; notes: string; active?: number }
export interface Planting {
  id: number; garden_id: number; plant_id: number; row: number; col: number; w: number; h: number;
  planted_on: string; last_watered: string | null; harvested_on: string | null; notes: string; plant: Plant;
  status: { germ_on: string; harvest_on: string; next_water: string | null; water_due: boolean; days_to_harvest: number; stage: 'sown' | 'growing' | 'ready' | 'harvested'; progress: number };
}
export interface GardenTask { kind: 'water' | 'germinate' | 'harvest'; date: string; overdue: number; planting_id: number; garden_id: number; garden: string; plant: string; glyph: string; color: string }

export interface MeshNode {
  id: number; node_id: string; label: string; site: string; long_name: string | null; short_name: string | null; hw_model: string | null; role: string | null;
  last_heard: number | null; battery: number | null; voltage: number | null; ch_util: number | null; air_util: number | null; uptime: number | null;
  snr: number | null; rssi: number | null; hops_away: number | null; temperature: number | null; lat: number | null; lon: number | null; via_gateway: string | null;
  online: boolean; lowBattery: boolean;
}

export const CATEGORIES = ['food', 'water', 'medical', 'hygiene', 'power', 'tools', 'comms', 'garden', 'other'] as const;
export const UNITS = ['ea', 'can', 'jar', 'box', 'bag', 'bottle', 'pack', 'lb', 'oz', 'kg', 'g', 'gal', 'L', 'roll', 'dose'];

export interface LinkShare { summary: boolean; inventory: boolean; power: boolean; mesh: boolean }
export interface LinkSummary {
  people: number; foodDays: number | null; waterDays: number | null; waterGallons: number;
  counts: { category: string; batches: number; qty: number }[];
  expired: number; soon: number; lowStock: number; power: { devices: number; due: number }; mesh: { total: number; online: number };
}
export interface LinkFeed {
  household: string; generated_at: number; shares: LinkShare; relay_channels: string[];
  summary?: LinkSummary;
  items?: { name: string; category: string; qty: number; unit: string; expires_on: string | null; min_qty: number | null }[];
  power?: { name: string; kind: string; brand: string; model: string; capacity_wh: number | null; output_w: number | null; fuel: string; charge_pct: number | null; next_due_on: string | null; next_task: string | null }[];
  mesh?: { node_id: string; name: string; short_name: string | null; site: string; hw_model: string | null; role: string | null; last_heard: number | null; online: boolean; battery: number | null; ch_util: number | null; snr: number | null; hops_away: number | null }[];
}
export interface RelayStats { sent: number; received: number; dropped: number; lastSentAt: number | null; lastReceivedAt: number | null; error: string | null }
export interface Link {
  id: number; status: 'active' | 'ended'; peer_url: string; peer_host: string; peer_household: string;
  share: LinkShare; relay_channels: string[]; relay: RelayStats | null;
  feed_at: number | null; pull_at: number | null; pull_error: string | null; seen_at: number | null; created_at: number;
  feed?: LinkFeed | null; summary: LinkSummary | null;
}
export interface LinksData {
  enabled: boolean; links: Link[]; codes: { id: number; created_at: number; expires_at: number }[];
  relay: { available: boolean; root: string | null; canEdit: boolean };
}
