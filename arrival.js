import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  scenarios: {
    test: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 15,
      maxVUs: 50,
    },
  },
};

export default function () {
  http.get('https://test.k6.io');
  sleep(2);
}