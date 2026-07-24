export function logInfo(message, data = undefined) {
  if (data === undefined) {
    console.log(`[info] ${message}`);
    return;
  }
  console.log(`[info] ${message}`, JSON.stringify(data, null, 2));
}

export function logWarn(message, data = undefined) {
  if (data === undefined) {
    console.warn(`[warn] ${message}`);
    return;
  }
  console.warn(`[warn] ${message}`, JSON.stringify(data, null, 2));
}

export function logError(message, error = undefined) {
  if (!error) {
    console.error(`[error] ${message}`);
    return;
  }

  const payload = error.response
    ? {
        status: error.response.status,
        data: error.response.data
      }
    : {
        name: error.name,
        message: error.message,
        stack: error.stack
      };

  console.error(`[error] ${message}`, JSON.stringify(payload, null, 2));
}
