// Deterministic seed data, applied fresh on every boot right after migrate(). Every seeded account
// shares one plaintext password (SEED_PASSWORD) so the smoke/test suite can always log in; the
// stored hashes still differ per boot because bcrypt salts randomly. The orders AUTOINCREMENT
// sequence is primed to firstOrderId-1 so the first booking placed on a fresh boot is always 8001.
import bcrypt from "bcryptjs";
import { config } from "../config.js";

export const SEED_PASSWORD = "eDemand-2026!";

function hash(password) {
  return bcrypt.hashSync(password, config.bcryptRounds);
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tomorrowDate() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function seed(db) {
  const run = db.transaction(() => {
    // ---- Categories ----
    const insertCategory = db.prepare(
      "INSERT INTO categories (name, slug) VALUES (?, ?)"
    );
    const cat = {};
    for (const [name, slug] of [
      ["Cleaning", "cleaning"],
      ["Repair", "repair"],
      ["Beauty", "beauty"],
      ["Appliance", "appliance"],
    ]) {
      cat[slug] = insertCategory.run(name, slug).lastInsertRowid;
    }

    // ---- Admin ----
    db.prepare(
      "INSERT INTO admins (email, password_hash, name) VALUES (?, ?, ?)"
    ).run("admin@edemand.test", hash(SEED_PASSWORD), "Ops Admin");

    // ---- Customers ----
    const insertCustomer = db.prepare(
      "INSERT INTO customers (email, password_hash, name, phone) VALUES (?, ?, ?, ?)"
    );
    const nong = insertCustomer.run("nong@example.com", hash(SEED_PASSWORD), "Nong Napat", "+66-81-000-0001").lastInsertRowid;
    const somchai = insertCustomer.run("somchai@example.com", hash(SEED_PASSWORD), "Somchai Boon", "+66-81-000-0002").lastInsertRowid;
    insertCustomer.run("aom@example.com", hash(SEED_PASSWORD), "Aom Piyada", "+66-81-000-0003");

    const insertAddress = db.prepare(
      "INSERT INTO addresses (customer_id, label, line1, area, city, lat, lng, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    insertAddress.run(nong, "Home", "123 Sukhumvit Soi 21", "Watthana", "Bangkok", 13.7367, 100.5626, 1);
    insertAddress.run(nong, "Work", "Silom Complex, Silom Rd", "Bang Rak", "Bangkok", 13.7278, 100.5341, 0);
    insertAddress.run(somchai, "Home", "88 Sathorn Rd", "Sathon", "Bangkok", 13.7192, 100.5296, 1);

    // ---- Providers + profiles + wallets + weekly timings ----
    const insertProvider = db.prepare(
      "INSERT INTO providers (email, password_hash, name, phone) VALUES (?, ?, ?, ?)"
    );
    const insertProfile = db.prepare(
      `INSERT INTO provider_profiles
         (provider_id, company_name, about, is_approved, commission_pct, service_radius_km, is_accepting_custom_jobs)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertWallet = db.prepare(
      "INSERT INTO provider_wallets (provider_id, balance_cents, commission_owed_cents) VALUES (?, 0, 0)"
    );
    const insertTiming = db.prepare(
      "INSERT INTO provider_timings (provider_id, weekday, opening_time, closing_time, is_open) VALUES (?, ?, ?, ?, ?)"
    );

    function makeProvider({ email, name, company, about, approved, commission, radius }) {
      const id = insertProvider.run(email, hash(SEED_PASSWORD), name, null).lastInsertRowid;
      insertProfile.run(id, company, about, approved ? 1 : 0, commission, radius, 1);
      insertWallet.run(id);
      // Weekday 0 = Sunday (closed), 1..6 = Mon..Sat (open 09:00–18:00).
      for (let wd = 0; wd <= 6; wd++) {
        insertTiming.run(id, wd, "09:00", "18:00", wd === 0 ? 0 : 1);
      }
      return id;
    }

    const sparkle = makeProvider({
      email: "sparkle@example.com", name: "Sparkle Cleaners", company: "Sparkle Cleaners Co.",
      about: "Deep cleaning specialists.", approved: true, commission: 15.0, radius: 12.0,
    });
    const fixit = makeProvider({
      email: "fixit@example.com", name: "FixIt Bros", company: "FixIt Bros Ltd.",
      about: "Repairs and appliances, done right.", approved: true, commission: 18.0, radius: 15.0,
    });
    const glow = makeProvider({
      email: "glow@example.com", name: "Glow Beauty", company: "Glow Beauty Studio",
      about: "At-home beauty and facials.", approved: false, commission: 20.0, radius: 10.0,
    });

    // ---- Services ----
    const insertService = db.prepare(
      `INSERT INTO services (provider_id, category_id, title, slug, description, price_cents, duration_min, tax_percent, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    );
    function makeService(providerId, categorySlug, title, priceCents, durationMin, description = "") {
      return insertService.run(
        providerId, cat[categorySlug], title, slugify(title), description, priceCents, durationMin, config.taxPercent
      ).lastInsertRowid;
    }
    makeService(sparkle, "cleaning", "Deep Home Cleaning", 120000, 180, "A thorough top-to-bottom home clean.");
    makeService(sparkle, "cleaning", "Sofa Shampoo", 60000, 90, "Fabric sofa deep-shampoo and dry.");
    makeService(fixit, "appliance", "AC Service & Clean", 45000, 60, "Air-conditioner service and coil clean.");
    makeService(fixit, "repair", "Leaky Tap Repair", 30000, 30, "Fix a dripping or leaking tap.");
    makeService(glow, "beauty", "Home Facial", 80000, 90, "Relaxing at-home facial treatment.");

    // ---- Job requests (2 open) ----
    const insertJob = db.prepare(
      `INSERT INTO job_requests (customer_id, category_id, title, description, min_price_cents, max_price_cents, window_start, window_end, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`
    );
    const t = tomorrowDate();
    insertJob.run(
      nong, cat["cleaning"], "Move-out deep clean, 2BR", "Empty 2-bedroom flat, move-out condition.",
      100000, 180000, `${t} 09:00`, `${t} 13:00`
    );
    const fridgeJob = insertJob.run(
      somchai, cat["appliance"], "Fridge not cooling", "Two-door fridge stopped cooling overnight.",
      30000, 70000, `${t} 14:00`, `${t} 17:00`
    ).lastInsertRowid;

    // FixIt seeds one pending bid on the fridge job so the bid-accept flow has data on boot.
    db.prepare(
      `INSERT INTO bids (job_request_id, provider_id, counter_price_cents, note, duration_min, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(fridgeJob, fixit, 55000, "Can come tomorrow afternoon, includes gas top-up.", 60);

    // Prime AUTOINCREMENT so the first order placed against a fresh boot always gets firstOrderId.
    db.prepare(
      "INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('orders', ?)"
    ).run(config.firstOrderId - 1);
  });

  run();
}
