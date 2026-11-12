/** The WhatsApp note that asks someone to join, signed with your @username so they can find you. */
export function inviteMessage(name: string, me: { name: string | null; username: string | null }, origin: string) {
  const first = name.trim().split(/\s+/)[0] || "there";
  return [
    `Hi ${first} 👋`,
    "",
    `I've started keeping our accounts on *Lekha*, so we can both see what's paid and what's pending, always up to date. No more checking old chats.`,
    "",
    `Join free here: ${origin}/sign-up`,
    me.username ? `Then add me as *@${me.username}*.` : "",
    "",
    me.name ? `– ${me.name}` : "",
  ]
    .filter((l, i, a) => l !== "" || (a[i - 1] ?? "") !== "")
    .join("\n")
    .trim();
}
