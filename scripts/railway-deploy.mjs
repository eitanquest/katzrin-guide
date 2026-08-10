// Connects the Railway service behind katzrin.ai to this GitHub repo (if not
// already connected) and triggers a fresh deployment of the latest main, then
// verifies the /awty page is live. Runs in GitHub Actions; needs RAILWAY_TOKEN.

const TOKEN = process.env.RAILWAY_TOKEN;
if (!TOKEN) {
  console.error("RAILWAY_TOKEN is not set");
  process.exit(1);
}

const REPO = "eitanquest/katzrin-guide";
const BRANCH = "main";
const SITE_CHECK_URL = "https://katzrin.ai/awty/";
const API = "https://backboard.railway.app/graphql/v2";

async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    const msg = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. Find all projects visible to this token (schema varies; try shapes) --

async function listProjects() {
  const attempts = [
    {
      q: `{ projects { edges { node { id name } } } }`,
      pick: (d) => d.projects?.edges?.map((e) => e.node),
    },
    {
      q: `{ me { projects { edges { node { id name } } } } }`,
      pick: (d) => d.me?.projects?.edges?.map((e) => e.node),
    },
    {
      q: `{ me { workspaces { id name team { projects { edges { node { id name } } } } } } }`,
      pick: (d) =>
        d.me?.workspaces?.flatMap(
          (w) => w.team?.projects?.edges?.map((e) => e.node) || []
        ),
    },
  ];
  for (const { q, pick } of attempts) {
    try {
      const projects = pick(await gql(q));
      if (projects?.length) return projects;
    } catch (e) {
      console.log(`(project query shape not supported: ${e.message})`);
    }
  }
  throw new Error("Could not list Railway projects with this token");
}

async function projectDetail(id) {
  const d = await gql(
    `query($id: String!) {
       project(id: $id) {
         id name
         services { edges { node { id name } } }
         environments { edges { node { id name } } }
       }
     }`,
    { id }
  );
  return d.project;
}

async function domainsFor(projectId, environmentId, serviceId) {
  try {
    const d = await gql(
      `query($p: String!, $e: String!, $s: String!) {
         domains(projectId: $p, environmentId: $e, serviceId: $s) {
           serviceDomains { domain }
           customDomains { domain }
         }
       }`,
      { p: projectId, e: environmentId, s: serviceId }
    );
    return [
      ...(d.domains?.customDomains || []),
      ...(d.domains?.serviceDomains || []),
    ].map((x) => x.domain);
  } catch {
    return [];
  }
}

// ---- main -------------------------------------------------------------------

const projects = await listProjects();
console.log(`Found ${projects.length} project(s): ${projects.map((p) => p.name).join(", ")}`);

// Locate the service that serves katzrin.ai (by domain, falling back to name).
let target = null;
outer: for (const p of projects) {
  const detail = await projectDetail(p.id);
  const services = detail.services.edges.map((e) => e.node);
  const envs = detail.environments.edges.map((e) => e.node);
  for (const s of services) {
    for (const env of envs) {
      const domains = await domainsFor(detail.id, env.id, s.id);
      console.log(`- ${detail.name} / ${s.name} / ${env.name}: ${domains.join(", ") || "(no domains)"}`);
      if (domains.some((d) => d.includes("katzrin"))) {
        target = { project: detail, service: s, env, domains };
        break outer;
      }
    }
  }
  if (!target && /katzrin/i.test(p.name)) {
    const env = envs.find((e) => e.name === "production") || envs[0];
    target = { project: detail, service: services[0], env, domains: [] };
  }
}

if (!target) {
  console.error("Could not find a Railway service for katzrin.ai");
  process.exit(1);
}
console.log(
  `Target: project "${target.project.name}", service "${target.service.name}", env "${target.env.name}"`
);

// ---- 2. Make sure the service is connected to the GitHub repo ---------------

try {
  const d = await gql(
    `query($s: String!, $e: String!) {
       serviceInstance(serviceId: $s, environmentId: $e) { source { repo image } }
     }`,
    { s: target.service.id, e: target.env.id }
  );
  console.log(`Current source: ${JSON.stringify(d.serviceInstance?.source)}`);
} catch (e) {
  console.log(`(could not read current source: ${e.message})`);
}

try {
  await gql(
    `mutation($id: String!, $repo: String!, $branch: String!) {
       serviceConnect(id: $id, input: { repo: $repo, branch: $branch }) { id }
     }`,
    { id: target.service.id, repo: REPO, branch: BRANCH }
  );
  console.log(`Connected service to ${REPO}@${BRANCH}`);
} catch (e) {
  console.log(`serviceConnect: ${e.message} (may already be connected — continuing)`);
}

// ---- 3. Trigger a deployment of the latest commit ---------------------------

let triggered = false;
for (const mutation of [
  `mutation($s: String!, $e: String!) { serviceInstanceDeployV2(serviceId: $s, environmentId: $e) }`,
  `mutation($s: String!, $e: String!) { serviceInstanceDeploy(serviceId: $s, environmentId: $e) }`,
]) {
  try {
    await gql(mutation, { s: target.service.id, e: target.env.id });
    triggered = true;
    console.log("Deployment triggered.");
    break;
  } catch (e) {
    console.log(`deploy mutation failed: ${e.message}`);
  }
}
if (!triggered) {
  console.error("Could not trigger a deployment");
  process.exit(1);
}

// ---- 4. Wait for the deployment to finish -----------------------------------

let status = "UNKNOWN";
for (let i = 0; i < 40; i++) {
  await sleep(15_000);
  try {
    const d = await gql(
      `query($p: String!, $s: String!, $e: String!) {
         deployments(first: 1, input: { projectId: $p, serviceId: $s, environmentId: $e }) {
           edges { node { id status } }
         }
       }`,
      { p: target.project.id, s: target.service.id, e: target.env.id }
    );
    status = d.deployments?.edges?.[0]?.node?.status || "UNKNOWN";
    console.log(`[${(i + 1) * 15}s] deployment status: ${status}`);
    if (["SUCCESS", "FAILED", "CRASHED", "REMOVED"].includes(status)) break;
  } catch (e) {
    console.log(`status poll failed: ${e.message}`);
  }
}

if (status !== "SUCCESS") {
  console.error(`Deployment did not succeed (status: ${status})`);
  process.exit(1);
}

// ---- 5. Verify the app is actually live -------------------------------------

await sleep(5000);
try {
  const res = await fetch(SITE_CHECK_URL, { redirect: "follow" });
  const html = await res.text();
  const ok = res.ok && html.includes("Are We There Yet");
  console.log(`Site check ${SITE_CHECK_URL}: HTTP ${res.status}, app present: ${ok}`);
  if (!ok) process.exit(1);
  console.log("LIVE ✔ — katzrin.ai/awty is serving the app.");
} catch (e) {
  console.error(`Site check failed: ${e.message}`);
  process.exit(1);
}
