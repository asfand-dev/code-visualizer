import axios from 'axios';

/** Browser HTTP client; every path is relative to `/api`. */
export const api = axios.create({ baseURL: '/api' });
