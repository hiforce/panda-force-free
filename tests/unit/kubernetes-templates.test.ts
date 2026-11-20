import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

const version = JSON.parse(readFileSync("release/community/edition.json", "utf8")).version;
function resources(mode: string): any[] {
  return parseAllDocuments(readFileSync(`panda-docs/static/downloads/kubernetes/panda-force-${mode}.yaml`, "utf8")).map(
    (document) => {
      expect(document.errors).toEqual([]);
      return document.toJS();
    },
  );
}
function pods(items: any[]) {
  return items
    .filter((item) => ["Deployment", "StatefulSet"].includes(item.kind))
    .map((item) => item.spec.template.spec);
}
const variable = (container: any, key: string) => container.env?.find((entry: any) => entry.name === key)?.value;

test("all Kubernetes application and init images follow the community release and platform", () => {
  for (const mode of ["isolated", "shared", "cluster"]) {
    for (const pod of pods(resources(mode))) {
      expect(pod.nodeSelector["kubernetes.io/os"]).toBe("linux");
      expect(pod.nodeSelector["kubernetes.io/arch"]).toBe("amd64");
      expect(pod.securityContext).toMatchObject({
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
      });
      for (const container of [...(pod.initContainers ?? []), ...pod.containers]) {
        expect(container.image).toBe(`hiforceai/panda-force:${version}`);
        expect(container.imagePullPolicy).toBe("IfNotPresent");
      }
      for (const container of pod.containers) {
        expect(container.ports).toContainEqual({ name: "http", containerPort: 8899 });
        for (const [probe, path] of [
          ["startupProbe", "/health/startup"],
          ["readinessProbe", "/health/readiness"],
          ["livenessProbe", "/health/liveness"],
        ]) {
          expect(container[probe].httpGet).toEqual({ path, port: "http" });
          expect(container[probe].timeoutSeconds).toBeGreaterThanOrEqual(3);
        }
        if (variable(container, "PANDA_FORCE_CLUSTER_ROLE") !== "gateway")
          expect(variable(container, "PANDA_FORCE_AUTH_MODE")).toBe("password");
      }
    }
  }
});

test("single-instance templates retain exclusive storage and consistent host-service mounts", () => {
  for (const mode of ["isolated", "shared"]) {
    const items = resources(mode),
      deployment = items.find((item) => item.kind === "Deployment"),
      pod = deployment.spec.template.spec;
    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.strategy.type).toBe("Recreate");
    expect(items.find((item) => item.kind === "PersistentVolumeClaim").spec.accessModes).toEqual(["ReadWriteOnce"]);
    const app = pod.containers[0];
    expect(app.volumeMounts).toContainEqual({ name: "state", mountPath: "/var/lib/panda-force" });
    expect(pod.initContainers[0].volumeMounts).toEqual([{ name: "state", mountPath: "/var/lib/panda-force" }]);
    expect(variable(app, "PANDA_FORCE_APP_SERVER_MODE")).toBe(mode);
    if (mode === "isolated") expect(pod.volumes.some((volume: any) => volume.hostPath)).toBe(false);
    else {
      const workspace = pod.volumes.find((volume: any) => volume.name === "host-workspace").hostPath.path;
      expect(pod.nodeSelector["kubernetes.io/hostname"]).toBe("REPLACE_WITH_NODE_NAME");
      for (const key of ["HOME", "PANDA_FORCE_CWD", "PANDA_FORCE_REVIEW_ROOT"])
        expect(variable(app, key)).toBe(workspace);
      expect(variable(app, "PANDA_FORCE_ATTACHMENT_ROOT").startsWith(workspace + "/")).toBe(true);
      expect(app.volumeMounts).toContainEqual({ name: "host-workspace", mountPath: workspace });
      expect(app.volumeMounts).toContainEqual({
        name: "host-control",
        mountPath: "/run/panda-force/codex-control",
        readOnly: true,
      });
      expect(variable(app, "PANDA_FORCE_APP_SERVER_SOCKET").startsWith("/run/panda-force/codex-control/")).toBe(true);
    }
    const service = items.find((item) => item.kind === "Service");
    expect(service.spec.selector).toEqual(deployment.spec.template.metadata.labels);
    expect(service.spec.ports[0].targetPort).toBe("http");
  }
});

test("gateway templates keep one fenced owner, stateless gateways and separately supplied coordination secrets", () => {
  const items = resources("cluster"),
    owner = items.find((item) => item.kind === "StatefulSet"),
    gateway = items.find((item) => item.kind === "Deployment");
  expect(owner.spec.replicas).toBe(1);
  expect(owner.spec.volumeClaimTemplates[0].spec.accessModes).toEqual(["ReadWriteOncePod"]);
  expect(gateway.spec.replicas).toBe(2);
  expect(gateway.spec.template.spec.volumes[0].emptyDir).toEqual({ sizeLimit: "256Mi" });
  expect(items.some((item) => item.kind === "Secret")).toBe(false);
  for (const pod of pods(items))
    for (const app of pod.containers) {
      for (const [name, key] of [
        ["PANDA_FORCE_CLUSTER_DATABASE_URL", "database-url"],
        ["PANDA_FORCE_CLUSTER_SECRET", "signing-key"],
      ]) {
        const env = app.env.find((entry: any) => entry.name === name);
        expect(env.value).toBeUndefined();
        expect(env.valueFrom.secretKeyRef).toEqual({ name: "panda-cluster", key });
      }
    }
});
