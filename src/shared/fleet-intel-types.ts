export interface MarketIntel {
  station_id: string
  station_name: string
  system_name: string
  item_id: string
  best_buy: number | null
  best_sell: number | null
  reported_by: string
  updated_at: string
}

export interface SystemIntel {
  system_id: string
  system_name: string
  empire: string | null
  poi_count: number
  has_station: boolean
  station_services: string | null
  resources: string | null
  discovered_by: string
  updated_at: string
}

export interface ThreatIntel {
  id: number
  system_id: string
  system_name: string
  threat_type: string
  description: string
  reported_by: string
  reported_at: string
  expires_at: string | null
}

export interface FleetIntelData {
  market: MarketIntel[]
  systems: SystemIntel[]
  threats: ThreatIntel[]
}
