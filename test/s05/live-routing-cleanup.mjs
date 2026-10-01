const knownErrorTypes = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "MissingProcessIdentity",
  "ProcessExitUnverified",
  "InvalidReservationCount",
]);

function safeErrorType(error) {
  try {
    const name = error instanceof Error ? error.name : "Error";
    return knownErrorTypes.has(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

export async function cleanupRoutingResources({
  context,
  browser,
  http,
  auth,
  service,
  serviceStartAttempted = false,
  processIdentity,
  verifyExited,
  budget,
  privateValues,
}) {
  const result = {
    contextClosed: !context,
    browserClosed: !browser,
    httpStopped: !http,
    authClosed: !auth,
    serviceStopped: !serviceStartAttempted,
    appServerExited: false,
    appServerExitStatus: serviceStartAttempted ? "unverified" : "not-started",
    ledgerReservationsRead: !budget,
    ledgerClosed: !budget,
    privateValuesCleared: !privateValues,
    reservedCalls: null,
    safeToRemoveFixture: false,
    errors: [],
  };
  const recordFailure = (stage, error) => {
    result.errors.push({ stage, errorType: safeErrorType(error) });
    process.exitCode = 1;
  };
  const attempt = async (stage, action) => {
    try {
      await action();
      return true;
    } catch (error) {
      recordFailure(stage, error);
      return false;
    }
  };

  if (context)
    result.contextClosed = await attempt("context-close", () =>
      context.close(),
    );
  if (browser)
    result.browserClosed = await attempt("browser-close", () =>
      browser.close(),
    );
  if (http)
    result.httpStopped = await attempt("operator-http-stop", () => http.stop());
  if (auth)
    result.authClosed = await attempt("operator-auth-close", () =>
      auth.close(),
    );

  if (serviceStartAttempted)
    result.serviceStopped = await attempt("service-stop", () => service.stop());

  if (serviceStartAttempted) {
    if (!processIdentity) {
      recordFailure(
        "app-server-exit-verification",
        Object.assign(new Error(), { name: "MissingProcessIdentity" }),
      );
    } else {
      result.appServerExited = await attempt(
        "app-server-exit-verification",
        async () => {
          const exit = await verifyExited(processIdentity);
          if (exit?.kind !== "verified")
            throw Object.assign(new Error(), { name: "ProcessExitUnverified" });
        },
      );
      if (result.appServerExited) result.appServerExitStatus = "verified";
    }
  }

  if (budget) {
    result.ledgerReservationsRead = await attempt(
      "ledger-reservation-read",
      () => {
        const reservedCalls = budget.reservedCalls();
        if (!Number.isSafeInteger(reservedCalls) || reservedCalls < 0)
          throw Object.assign(new Error(), {
            name: "InvalidReservationCount",
          });
        result.reservedCalls = reservedCalls;
      },
    );
    result.ledgerClosed = await attempt("ledger-close", () => budget.close());
  }
  if (privateValues)
    result.privateValuesCleared = await attempt("private-values-clear", () =>
      privateValues.clear(),
    );

  result.safeToRemoveFixture =
    result.contextClosed &&
    result.browserClosed &&
    result.httpStopped &&
    result.authClosed &&
    result.serviceStopped &&
    (result.appServerExitStatus === "not-started" ||
      result.appServerExitStatus === "verified") &&
    result.ledgerReservationsRead &&
    result.ledgerClosed &&
    result.privateValuesCleared &&
    result.errors.length === 0;
  if (!result.safeToRemoveFixture) process.exitCode = 1;
  return result;
}
