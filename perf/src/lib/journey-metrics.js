// Journey-level metrics, defined ONCE and shared by every flow (journeys/ files and the
// flow-level mix import the same instances — two `new Trend()` calls with one name from two
// modules would double-register the metric).
//   perf_journey_duration — wall time of the full chain, recorded only on fully successful
//                           journeys (mirrors the success-only caliber of perf_success_duration)
//   perf_journey_success  — journey-level success rate (every step OK)
import { Trend, Rate } from 'k6/metrics';

export const journeyDuration = new Trend('perf_journey_duration', true);
export const journeySuccess = new Rate('perf_journey_success');
