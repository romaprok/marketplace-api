// Everything the course API needs in the cluster (hw-28): npm run up.
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

// First, before anything talks to the cluster: the runtime secret. It comes
// from the vault through scripts/with-secrets.sh, and there is no default on
// purpose. A default here would be a password baked into the repo.
const dbPassword = process.env.DB_PASSWORD;
if (!dbPassword) {
  throw new Error('DB_PASSWORD is required: it comes from the vault via scripts/with-secrets.sh (README, Kubernetes)');
}

const config = new pulumi.Config();
const profile = config.get('profile') ?? 'hardened';
if (profile !== 'hardened' && profile !== 'naive') throw new Error(`profile must be hardened or naive, got ${profile}`);
const hardened = profile === 'hardened';
const replicas = config.getNumber('replicas') ?? 3;
const image = config.get('image') ?? 'marketplace-api:hw28';
const rev = config.get('rev') ?? '1';

// What the pod does at start and stop, see src/server.js. The grace period
// has to outlast the drain plus the final close, or SIGKILL lands mid-drain.
const WARMUP_MS = 4000;
const DRAIN_MS = 5000;
const GRACE_SECONDS = 15;

const provider = new k8s.Provider('kind', { context: config.get('kubeContext') ?? 'kind-marketplace' });
const opts = { provider };
const labels = { app: 'marketplace-api' };

const ns = new k8s.core.v1.Namespace('marketplace', { metadata: { name: 'marketplace' } }, opts);
const namespace = ns.metadata.name;

// data, not stringData: stringData is write-only, the API never returns it,
// and every `up` would see a difference. base64 is not encryption: in kind
// the value sits in etcd as plain text. The Secret keeps it out of git.
const secret = new k8s.core.v1.Secret(
  'api-secrets',
  {
    metadata: { name: 'api-secrets', namespace },
    type: 'Opaque',
    data: { DB_PASSWORD: pulumi.secret(Buffer.from(dbPassword).toString('base64')) },
  },
  opts,
);

// Typed through Pick on purpose: a misspelled field in a conditional spread
// slips past tsc, a misspelled key of this object doesn't.
const probes: Pick<k8s.types.input.core.v1.Container, 'startupProbe' | 'readinessProbe' | 'livenessProbe'> = hardened
  ? {
      // up to 30 s to warm up; liveness and readiness wait for it
      startupProbe: { httpGet: { path: '/healthz', port: 'http' }, periodSeconds: 1, failureThreshold: 30 },
      // "may I get traffic": red during warm-up and from the first moment of SIGTERM
      readinessProbe: { httpGet: { path: '/readyz', port: 'http' }, periodSeconds: 1, failureThreshold: 1, timeoutSeconds: 1 },
      // "should I be killed": a different URL, so "not ready" never turns into a restart loop
      livenessProbe: { httpGet: { path: '/healthz', port: 'http' }, periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 2 },
    }
  : {};

const deployment = new k8s.apps.v1.Deployment(
  'api',
  {
    metadata: { name: 'api', namespace, labels },
    spec: {
      // stays even with the HPA below; README "Kubernetes" on why that is a field ownership conflict on a real cluster
      replicas,
      selector: { matchLabels: labels },
      strategy: {
        type: 'RollingUpdate',
        // 0 unavailable: an old pod goes only after a new one said "ready"
        rollingUpdate: hardened ? { maxUnavailable: 0, maxSurge: 1 } : { maxUnavailable: 1, maxSurge: 1 },
      },
      template: {
        metadata: { labels },
        spec: {
          // naive: the default 30 s; its app doesn't drain anyway
          terminationGracePeriodSeconds: hardened ? GRACE_SECONDS : undefined,
          securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
          containers: [
            {
              name: 'api',
              image,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ name: 'http', containerPort: 3000 }],
              env: [
                { name: 'NODE_ENV', value: 'production' },
                { name: 'PORT', value: '3000' },
                { name: 'DB_URL', value: config.get('dbUrl') ?? 'postgres://marketplace@host.docker.internal:6432/marketplace' },
                // a reference, never the value: the manifest only names the Secret
                { name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: secret.metadata.name, key: 'DB_PASSWORD' } } },
                { name: 'WARMUP_MS', value: String(WARMUP_MS) },
                { name: 'DRAIN_MS', value: hardened ? String(DRAIN_MS) : '0' },
                // a template change is what starts a rollout; demo:rollout bumps it
                { name: 'REV', value: rev },
              ],
              resources: { requests: { cpu: '100m', memory: '96Mi' }, limits: { cpu: '500m', memory: '192Mi' } },
              // a number, not the image's "nonroot": kubelet can't check a name against runAsNonRoot
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 65532,
                runAsGroup: 65532,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              ...probes,
            },
          ],
        },
      },
    },
  },
  opts,
);

const service = new k8s.core.v1.Service(
  'api',
  {
    metadata: { name: 'api', namespace, labels },
    spec: {
      type: 'NodePort',
      selector: labels,
      ports: [{ name: 'http', port: 80, targetPort: 'http', nodePort: 30080 }],
    },
  },
  opts,
);

// One pod may go for maintenance, never two. minAvailable == replicas would
// block every drain, and with one replica a PDB protects nothing.
const pdb = new k8s.policy.v1.PodDisruptionBudget(
  'api',
  { metadata: { name: 'api', namespace }, spec: { minAvailable: replicas - 1, selector: { matchLabels: labels } } },
  opts,
);

// kind has no metrics-server, so this scales nothing there (cpu: <unknown>/70%).
const hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(
  'api',
  {
    metadata: { name: 'api', namespace },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: deployment.metadata.name },
      minReplicas: replicas,
      maxReplicas: replicas * 2,
      metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }],
    },
  },
  opts,
);

export const namespaceName = namespace;
export const deploymentName = deployment.metadata.name;
export const serviceUrl = pulumi.interpolate`http://127.0.0.1:${service.spec.ports[0].nodePort}`;
export const pdbName = pdb.metadata.name;
export const hpaName = hpa.metadata.name;
export const activeProfile = profile;
export const activeRev = rev;
