import { requireUser } from "@/lib/server/context";
import { userDb } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/bits";
import type { NotificationRow } from "@/lib/notifications";
import { NotificationList } from "./list";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const userId = await requireUser();
  const db = await userDb();
  // Overdue invoices and advances become reminders here, once each.
  await db.rpc("refresh_my_reminders");
  const { data } = await db
    .from("notifications")
    .select("id, kind, actor_name, subject, amount, direction, detail, href, created_at, read_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (data ?? []) as NotificationRow[];
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Notifications">
        <p className="mt-3 text-ink-2">New entries, payments and expenses others add with you, confirmations, invoice updates and reminders.</p>
      </PageHeader>
      <NotificationList rows={rows} />
    </div>
  );
}
