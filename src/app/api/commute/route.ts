import 'server-only';
import { createCommuteHandler } from '../../../server/commute-handler.js';
import { getCommuteService, getHistoryBackendName } from '../../../server/commute-runtime.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export const GET = createCommuteHandler(getCommuteService, () => process.env.MTA_BUS_TIME_API_KEY, getHistoryBackendName);
