// Logging must never be the thing that breaks a booking, so serialising a value
// that JSON.stringify refuses (a circular object, a BigInt) degrades to a note
// rather than throwing into the caller.
function serialise(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `[unserialisable: ${error?.message}]`;
  }
}

export function logInfo(message, data = undefined) {
  if (data === undefined) {
    console.log(`[info] ${message}`);
    return;
  }
  console.log(`[info] ${message}`, serialise(data));
}

export function logWarn(message, data = undefined) {
  if (data === undefined) {
    console.warn(`[warn] ${message}`);
    return;
  }
  console.warn(`[warn] ${message}`, serialise(data));
}

// Second argument may be an axios error, an Error, or a plain object of
// diagnostic context. Plain objects used to fall through the Error branch and
// print as `{}` — every field undefined — which hid the very details the call
// site passed in.
export function logError(message, error = undefined) {
  if (!error) {
    console.error(`[error] ${message}`);
    return;
  }

  let payload;
  if (error.response) {
    payload = { status: error.response.status, data: error.response.data };
  } else if (error instanceof Error) {
    payload = { name: error.name, message: error.message, stack: error.stack };
  } else {
    payload = error;
  }

  console.error(`[error] ${message}`, serialise(payload));
}
