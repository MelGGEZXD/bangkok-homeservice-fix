import { config } from "../../config.js";
import { AppError, BadGatewayError } from "../../errors.js";
import { getPaymentsWorkerToken } from "../../http/keycloak.js";

export async function paymentsRequest(path, { body, token, timeout = config.paymentsTimeoutMs } = {}) {
  let response, result;
  try {
    const authorization = `Bearer ${token ?? await getPaymentsWorkerToken()}`;
    response = await fetch(new URL(path, config.paymentsServiceUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout), cache: "no-store",
    });
    result = await response.json();
  } catch {
    throw new BadGatewayError("payments service unavailable");
  }
  return { response, result };
}

export async function callPayments(path, options) {
  const { response, result } = await paymentsRequest(path, options);
  if (response.ok) return result;
  if (response.status >= 500) throw new BadGatewayError("payments service unavailable");
  throw new AppError(response.status, result.error || "payments request rejected");
}
