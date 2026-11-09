// Catalog business logic: browse categories, list/search services, service detail, and a provider
// managing their own services. Duration must be a positive multiple of 30 (the DB CHECK enforces it
// too; we validate up front for a clean 400 instead of a constraint 500).
import * as repository from "./repository.js";
import { NotFoundError, ForbiddenError, BadRequestError } from "../../errors.js";

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function listCategories() {
  return repository.listActiveCategories();
}

export function servicesInCategory(slug) {
  const category = repository.findCategoryBySlug(slug);
  if (!category || category.status !== 1) throw new NotFoundError(`category '${slug}' not found`);
  return {
    category: { id: category.id, name: category.name, slug: category.slug },
    services: repository.listByCategoryApproved(category.id).map(repository.toPublicService),
  };
}

export function searchServices({ category_id, provider_id, q, page, size }) {
  const offset = (page - 1) * size;
  const { rows, total } = repository.searchServices({
    categoryId: category_id,
    providerId: provider_id,
    q,
    limit: size,
    offset,
  });
  return { items: rows.map(repository.toPublicService), total, page, size };
}

export function getService(id) {
  const row = repository.findServiceById(id);
  if (!row) throw new NotFoundError(`service ${id} not found`);
  return repository.toPublicService(row);
}

export function topRated(limit = 6) {
  return repository.topRatedServices(limit).map(repository.toPublicService);
}

export function listOwnServices(providerId) {
  return repository.listByProvider(providerId).map(repository.toPublicService);
}

export function createService(providerId, input) {
  if (input.duration_min <= 0 || input.duration_min % 30 !== 0) {
    throw new BadRequestError("validation failed", [
      { path: "duration_min", message: "must be a positive multiple of 30 minutes" },
    ]);
  }
  const category = repository.findCategoryById(input.category_id);
  if (!category) throw new BadRequestError("validation failed", [{ path: "category_id", message: "unknown category" }]);

  const id = repository.insertService({
    providerId,
    categoryId: input.category_id,
    title: input.title,
    slug: slugify(input.title),
    description: input.description,
    priceCents: input.price_cents,
    durationMin: input.duration_min,
    taxPercent: input.tax_percent ?? 7.0,
  });
  return repository.toPublicService(repository.findServiceById(id));
}

export function updateOwnService(providerId, serviceId, input) {
  const service = repository.findServiceRaw(serviceId);
  if (!service) throw new NotFoundError(`service ${serviceId} not found`);
  if (service.provider_id !== providerId) throw new ForbiddenError("you do not own this service");

  if (input.duration_min !== undefined && (input.duration_min <= 0 || input.duration_min % 30 !== 0)) {
    throw new BadRequestError("validation failed", [
      { path: "duration_min", message: "must be a positive multiple of 30 minutes" },
    ]);
  }

  const fields = {};
  for (const key of ["category_id", "title", "description", "price_cents", "duration_min", "tax_percent", "status"]) {
    if (input[key] !== undefined) fields[key] = input[key];
  }
  if (input.title !== undefined) fields.slug = slugify(input.title);
  repository.updateService(serviceId, fields);
  return repository.toPublicService(repository.findServiceById(serviceId));
}
