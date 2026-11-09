export const dynamic = "force-dynamic";

import { redirect, notFound } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as catalog from "#lib/modules/catalog/service.js";
import * as booking from "#lib/modules/booking/service.js";
import { money } from "../../../_ui/format.js";
import { BookingForm } from "../../../_ui/client.js";

export default function BookPage({ params }) {
  const session = getSession();
  if (!session || session.role !== "customer") redirect("/login");

  let service;
  try {
    service = catalog.getService(Number(params.serviceId));
  } catch {
    notFound();
  }
  const addresses = booking.listAddresses(session.sub);

  return (
    <div style={{ maxWidth: 560 }}>
      <p className="small"><a href={`/services/${service.id}`}>← {service.title}</a></p>
      <h1>Book: {service.title}</h1>
      <p className="muted">{money(service.price_cents)} · {service.duration_min} min · {service.provider_name}</p>
      <BookingForm
        serviceId={service.id}
        providerId={service.provider_id}
        duration={service.duration_min}
        addresses={addresses.map((a) => ({ id: a.id, label: a.label, line1: a.line1, city: a.city }))}
      />
    </div>
  );
}
