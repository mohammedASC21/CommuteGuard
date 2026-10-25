import { requireLocal, localReply } from './local-api.js';
import { TEST_NOTIFICATION } from '../lib/notifications/model.js';
import { expiredSubscription, type PushSender } from '../lib/notifications/sender.js';
import type { NotificationStore } from '../lib/notifications/store.js';

/** Delivery test only: no clock, settings, scheduler or reliability dependency. */
export function createTestNotificationHandler(
  storeFactory: () => Pick<NotificationStore, 'subscription' | 'removeSubscription'>,
  senderFactory: () => PushSender,
) {
  return async function POST(request: Request) {
    try { requireLocal(request,true); } catch { return localReply({error:'LOCAL_ONLY'},403); }
    try {
      const store = storeFactory(), subscription = await store.subscription();
      if (!subscription) return localReply({error:'NOT_SUBSCRIBED'},409);
      try { await senderFactory()(subscription,TEST_NOTIFICATION); }
      catch(error) { if (expiredSubscription(error)) await store.removeSubscription(subscription.endpoint); return localReply({error:'PUSH_FAILED'},503); }
      return localReply({accepted:true});
    } catch { return localReply({error:'PUSH_UNAVAILABLE'},503); }
  };
}
