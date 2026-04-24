import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD ? '' : 'http://localhost:3001');

const http = axios.create({ baseURL: `${BASE_URL}/api` });

function locParam(locationId) {
  return locationId != null ? { location_id: locationId } : {};
}

export const getLocations    = ()           => http.get('/locations').then(r => r.data);
export const getKPIs         = (locationId) => http.get('/dashboard/kpis',            { params: locParam(locationId) }).then(r => r.data);
export const getRevenueByRep = (locationId) => http.get('/dashboard/revenue-by-rep',  { params: locParam(locationId) }).then(r => r.data);
export const getDailyRevenue = (locationId) => http.get('/dashboard/daily-revenue',   { params: locParam(locationId) }).then(r => r.data);
export const getRecentJobs   = (locationId) => http.get('/dashboard/recent-jobs',     { params: locParam(locationId) }).then(r => r.data);

export const getSalesKPIs     = ()     => http.get('/sales/kpis').then(r => r.data);
export const triggerSalesSync = ()     => http.get('/sales/sync/now').then(r => r.data);
// Pass browser local date (YYYY-MM-DD) to avoid UTC vs local timezone mismatch on the server
export const getSalesToday    = (date) => http.get('/sales/today', { params: { date } }).then(r => r.data);
export const getSalesAnnual   = ()     => http.get('/sales/annual').then(r => r.data);
