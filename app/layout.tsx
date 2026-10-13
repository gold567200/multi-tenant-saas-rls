import type { ReactNode } from "react";

export const metadata = {
  title: "Multi-tenant RLS demo",
  description:
    "PostgreSQL Row-Level Security enforcing per-tenant data isolation.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          maxWidth: 680,
          margin: "40px auto",
          padding: "0 16px",
          lineHeight: 1.5,
          color: "#111",
        }}
      >
        {children}
      </body>
    </html>
  );
}
