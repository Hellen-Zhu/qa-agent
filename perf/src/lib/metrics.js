import { Trend, Counter } from 'k6/metrics';

// 业务级指标：区分「HTTP 层健康」与「业务层健康」
export const bookingDuration = new Trend('trade_booking_duration', true);
export const bookingErrors = new Counter('trade_booking_errors');
export const bizErrors = new Counter('business_errors');
