import http from 'k6/http';
import { check, sleep } from 'k6';

/**
 * Запуск:
 *   k6 run load-test.js
 *   k6 run -e BASE_URL=https://api.example.com -e PATH=/health load-test.js
 *
 * Переменные окружения:
 *   BASE_URL — базовый URL (по умолчанию https://test.k6.io)
 *   PATH     — путь запроса (по умолчанию /)
 */

const BASE_URL = __ENV.BASE_URL || 'https://test.k6.io';
const PATH = __ENV.PATH || '/';
const url = `${BASE_URL.replace(/\/$/, '')}${PATH.startsWith('/') ? PATH : `/${PATH}`}`;

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 10 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

export default function () {
  const res = http.get(url);

  check(res, {
    'статус 200': (r) => r.status === 200,
    'есть тело ответа': (r) => r.body && r.body.length > 0,
  });

  sleep(1);
}
