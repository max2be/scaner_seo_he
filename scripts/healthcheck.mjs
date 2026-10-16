const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`, { signal: AbortSignal.timeout(3000) });
if (!response.ok || (await response.json()).status !== 'ok') process.exitCode = 1;
