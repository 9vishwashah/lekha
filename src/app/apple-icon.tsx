import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon: the Lekha mark on seashell. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#f2eee7" }}>
        <svg width="132" height="132" viewBox="0 0 30 30">
          <rect x="1" y="5" width="28" height="22" rx="7" fill="#1d1d1b" />
          <rect x="1" y="3" width="20" height="12" rx="5" fill="#eac119" />
          <circle cx="22" cy="17" r="2.6" fill="#eae4da" />
        </svg>
      </div>
    ),
    size,
  );
}
