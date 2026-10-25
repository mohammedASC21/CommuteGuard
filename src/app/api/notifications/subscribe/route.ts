import { notificationStore } from '../../../../server/notification-runtime.js';
import { requireLocal, localBody, localReply } from '../../../../server/local-api.js';
import { validateSubscription } from '../../../../lib/notifications/model.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try { requireLocal(request,true); } catch { return localReply({error:'LOCAL_ONLY'},403); }
  let subscription;
  try { subscription = validateSubscription(await localBody(request)); }
  catch { return localReply({error:'INVALID_SUBSCRIPTION'},400); }
  try { await notificationStore().saveSubscription(subscription); return localReply({subscribed:true}); }
  catch { return localReply({error:'SUBSCRIPTION_UNAVAILABLE'},503); }
}
