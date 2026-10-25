import { notificationStore } from '../../../server/notification-runtime.js';
import { requireLocal, localBody, localReply } from '../../../server/local-api.js';
import { validateTime } from '../../../lib/notifications/model.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { requireLocal(request); return localReply(await notificationStore().settings()); }
  catch { return localReply({error:'SETTINGS_UNAVAILABLE'},503); }
}
export async function PUT(request: Request) {
  try { requireLocal(request,true); } catch { return localReply({error:'LOCAL_ONLY'},403); }
  let time: string;
  try { const body = await localBody(request) as {departure_time?:unknown}; time = validateTime(body?.departure_time); }
  catch { return localReply({error:'INVALID_DEPARTURE_TIME'},400); }
  try { const store = notificationStore(); await store.saveTime(time); return localReply(await store.settings()); }
  catch { return localReply({error:'SETTINGS_UNAVAILABLE'},503); }
}
