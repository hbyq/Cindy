/**
 * Fork-only client update policy.
 *
 * hbyq/Cindy currently publishes one verified stable channel. Keep the Beta
 * client channel unavailable until the fork owns a separate Beta manifest and
 * release namespace; probing the official Beta feed while downloading from the
 * fork stable feed would expose a switch that cannot honor its promise.
 */
export function isForkBetaUpdateChannelAvailable(): boolean {
  return false;
}
