/**
 * Whether this deployment is configured for the exposure it actually has.
 *
 * `docs/deployment.md` names two settings a public instance must have:
 * `ADMIN_PASSWORD`, because the default is printed in the README, and
 * `ALLOW_PRIVATE_CALLBACKS=false`, marked "Required for a public instance".
 * Nothing enforced either. A deployment that forgot them served a dashboard
 * whose password is public knowledge, with the callback guard in its
 * permissive mode, and said nothing — the failure mode being that everything
 * appears to work.
 *
 * ## Why this is not the companion dashboard's `assertDeployable`
 *
 * That one is middleware on a single Hono app: it refuses every request with a
 * 503 naming the problem, and keeps `/health` open so the refusal is visible.
 * This repository has no single entry point — each file under `api/` is its
 * own function — so the equivalent would mean either an import-time throw,
 * which turns a configuration mistake into an opaque 500, or a check added to
 * every handler, which is a wide diff and one more thing to forget.
 *
 * So the same idea is applied where it bites instead: the two chokepoints that
 * every affected path already passes through. `lib/auth.js` refuses the
 * published default once deployed, and `lib/urlGuard.js` treats an unset
 * `ALLOW_PRIVATE_CALLBACKS` as strict once deployed. Both fail closed, and
 * both leave an explicit way to say otherwise.
 */

/**
 * Is this running on a deployment rather than someone's machine?
 *
 * `VERCEL` is set to "1" by the platform on every deployment it runs,
 * production and preview alike. Preview being included is deliberate: a
 * preview URL is as reachable as a production one.
 *
 * Deliberately not `NODE_ENV`, which says how the code was built rather than
 * who can reach it, and which a local `npm start` sets to nothing in
 * particular.
 *
 * @returns {boolean} True when the platform says this is deployed
 */
export function isPublicDeployment() {
  return process.env.VERCEL === '1';
}

/**
 * Settings that must be set on a deployment and are not.
 *
 * Empty when running locally, where the defaults are the point — the README
 * quick start depends on `mockpay` working and on loopback callbacks being
 * allowed, and a check that broke those would be a check people disable.
 *
 * @returns {string[]} Human-readable problems, empty when sound
 */
export function deploymentProblems() {
  if (!isPublicDeployment()) return [];

  const problems = [];

  if (!process.env.ADMIN_PASSWORD) {
    problems.push(
      'ADMIN_PASSWORD is unset — the default is printed in this repository\'s README, ' +
      'so the admin dashboard and every /api/admin/* route are refused until it is set'
    );
  }

  if (process.env.ALLOW_PRIVATE_CALLBACKS === undefined) {
    problems.push(
      'ALLOW_PRIVATE_CALLBACKS is unset — callbacks to private and loopback addresses ' +
      'are refused on a deployment; set it to "true" to allow them deliberately'
    );
  }

  return problems;
}

/**
 * Print the problems once per process.
 *
 * Once, because these are read per request and a warning on every one is a
 * warning nobody reads. A log is the weaker half of this anyway — the
 * enforcement is that the two chokepoints fail closed — so it exists to tell
 * whoever is looking at the logs why their password stopped working.
 */
let announced = false;

export function announceDeploymentProblems() {
  if (announced) return;

  const problems = deploymentProblems();
  if (problems.length === 0) return;

  announced = true;
  console.error('[deployment] This instance is missing configuration it needs:');
  for (const problem of problems) console.error(`[deployment]   - ${problem}`);
}
