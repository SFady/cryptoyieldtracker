// Paramètres fixes de l'algo CLM Neutral Zone Hedge
export const ALGO_CONFIG = {
  RANGE_PCT:               0.01,   // ±1% autour du midpoint (range totale 2%)
  TICK_SPACING:            100,    // CL100 sur Aerodrome
  NEUTRAL_ZONE_PCT:        0.003,  // ±0.3% autour du midpoint
  REBALANCE_DELAY_MIN:     30,     // attendre 30 min hors range avant rebalance
  REBALANCE_THRESHOLD_PCT: 0.005,  // 0.5% hors range → rebalance immédiat
  POOL_NUM:                2,
};

// Clés Redis pour la persistance entre cron ticks
export const REDIS_KEYS = {
  POSITION_STATE: 'p2_algo_position_state', // { lowerTick, upperTick, lowerPrice, upperPrice, midPrice, neutralZoneLow, neutralZoneHigh }
  HEDGE_STATE:    'p2_algo_hedge_state',    // { shortState: "ON"|"OFF", shortEntryPrice: number|null }
  OOR_SINCE:      'p2_algo_oor_since',      // timestamp ISO quand LP est sortie de range
  RUNTIME_CONFIG: 'p2_algo_runtime_config', // { capital, shortSizeUsd, leverage } — défini au Start
};
