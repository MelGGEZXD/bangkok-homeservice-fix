import "./globals.css";
import { getSession } from "#lib/http/session.js";
import { LogoutButton } from "./_ui/client.js";

export const metadata = {
  title: "eDemand — home services marketplace",
  description: "DES428 case study: a multi-vendor on-demand home-services marketplace monolith.",
};

function Nav({ session }) {
  if (!session) {
    return (
      <nav>
        <a href="/">Browse</a>
        <a href="/providers">Providers</a>
        <div className="spacer" />
        <a href="/login">Log in</a>
        <a href="/register">Sign up</a>
        <a href="/provider/login" className="muted small">Provider</a>
        <a href="/admin/login" className="muted small">Admin</a>
      </nav>
    );
  }
  if (session.role === "customer") {
    return (
      <nav>
        <a href="/">Browse</a>
        <a href="/bookings">My bookings</a>
        <a href="/jobs">My jobs</a>
        <a href="/notifications">Notifications</a>
        <div className="spacer" />
        <span className="muted small">{session.email}</span>
        <LogoutButton />
      </nav>
    );
  }
  if (session.role === "provider") {
    return (
      <nav>
        <a href="/provider/dashboard">Dashboard</a>
        <a href="/provider/services">Services</a>
        <a href="/provider/bookings">Bookings</a>
        <a href="/provider/jobs">Jobs</a>
        <a href="/provider/availability">Availability</a>
        <a href="/provider/wallet">Wallet</a>
        <a href="/notifications">Notifications</a>
        <div className="spacer" />
        <LogoutButton />
      </nav>
    );
  }
  return (
    <nav>
      <a href="/admin/providers">Providers</a>
      <a href="/admin/bookings">Bookings</a>
      <a href="/notifications">Notifications</a>
      <div className="spacer" />
      <LogoutButton />
    </nav>
  );
}

export default function RootLayout({ children }) {
  const session = getSession();
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="inner">
            <a className="brand" href="/">eDemand</a>
            <Nav session={session} />
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
