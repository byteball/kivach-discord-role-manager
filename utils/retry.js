const RETRY_DELAY = 1000 * 30; // 30 seconds

// Runs fn, on failure waits and tries once more.
// If the second attempt fails too, the error is thrown and crashes the process, so that the problem is noticed
async function retry(fn) {
  try {
    return await fn();
  } catch (e) {
    console.error("Request failed, will retry", e);

    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));

    return await fn();
  }
}

exports.retry = retry;
