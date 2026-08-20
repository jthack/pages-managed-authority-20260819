const { createHash } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");

const socketPath =
  process.env.DROSS_TEST_DOCKER_SOCKET || "/var/run/docker.sock";
const builderHostnamePath =
  process.env.DROSS_TEST_BUILDER_HOSTNAME_FILE || "/etc/hostname";
const image = "ghcr.io/actions/jekyll-build-pages:v1.0.13";
const hostSource = "/etc/hostname";
const childTarget = "/etc/hostname";
const bind = `${hostSource}:${childTarget}:ro`;
const label = "inert-host-hostname-boundary-control";
const name = `managed-pages-safe-${process.pid}-${Date.now()}`;
const childScript = [
  `data = File.binread(${JSON.stringify(childTarget)})`,
  "shape = !!data.match(/\\A[A-Za-z0-9][A-Za-z0-9._-]{0,252}\\n?\\z/)",
  "STDOUT.write(JSON.generate({sha256: Digest::SHA256.hexdigest(data), length: data.bytesize, strict_hostname_shape: shape}))",
].join("; ");

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const client = http.request(
      {
        socketPath,
        method,
        path: route,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": payload.length,
            }
          : {},
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    client.on("error", reject);
    client.setTimeout(20000, () =>
      client.destroy(new Error("docker request timed out")),
    );
    if (payload) client.write(payload);
    client.end();
  });
}

function json(response) {
  return response.body.length
    ? JSON.parse(response.body.toString("utf8"))
    : {};
}

function logs(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    if (![0, 1, 2].includes(stream) || offset + 8 + length > buffer.length) {
      return buffer.toString("utf8");
    }
    chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return offset === buffer.length
    ? Buffer.concat(chunks).toString("utf8")
    : buffer.toString("utf8");
}

function hostnameSummary(buffer) {
  const contentLength = buffer.at(-1) === 0x0a ? buffer.length - 1 : buffer.length;
  let strictShape = contentLength >= 1 && contentLength <= 253;
  for (let index = 0; strictShape && index < contentLength; index++) {
    const byte = buffer[index];
    const alphaNumeric =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a);
    const punctuation = byte === 0x2d || byte === 0x2e || byte === 0x5f;
    strictShape = index === 0 ? alphaNumeric : alphaNumeric || punctuation;
  }
  if (strictShape && buffer.length !== contentLength) {
    strictShape = buffer.length === contentLength + 1 && buffer.at(-1) === 0x0a;
  }
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    length: buffer.length,
    strict_hostname_shape: strictShape,
  };
}

function requireSummary(value, labelName) {
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !== "length,sha256,strict_hostname_shape" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isInteger(value.length) ||
    value.length < 1 ||
    value.length > 254 ||
    value.strict_hostname_shape !== true
  ) {
    throw new Error(`${labelName} summary failed strict validation`);
  }
}

function exactArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((item, index) => value[index] === item)
  );
}

async function main(options = {}) {
  const requestDocker = options.request ?? request;
  const builderPath = options.builderHostnamePath ?? builderHostnamePath;
  const builder = hostnameSummary(fs.readFileSync(builderPath));
  requireSummary(builder, "builder hostname");

  let id = null;
  let failure = null;
  let host = null;
  try {
    const created = await requestDocker(
      "POST",
      `/v1.41/containers/create?name=${encodeURIComponent(name)}`,
      {
        Image: image,
        Entrypoint: ["/usr/local/bin/ruby", "-rjson", "-rdigest", "-e"],
        Cmd: [childScript],
        User: "65534:65534",
        AttachStdout: true,
        AttachStderr: true,
        Labels: {
          "rez0.managed-pages": label,
        },
        HostConfig: {
          Binds: [bind],
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          PidsLimit: 16,
          Memory: 67108864,
          Privileged: false,
        },
      },
    );
    if (created.status !== 201) throw new Error(`create=${created.status}`);
    id = json(created).Id;
    if (!id) throw new Error("create omitted id");

    const inspected = await requestDocker("GET", `/v1.41/containers/${id}/json`);
    if (inspected.status !== 200) throw new Error(`inspect=${inspected.status}`);
    const state = json(inspected);
    const mounts = state.Mounts ?? [];
    const securityOpt = state.HostConfig?.SecurityOpt ?? [];
    if (
      state.Config?.Image !== image ||
      state.Config?.User !== "65534:65534" ||
      state.Config?.Labels?.["rez0.managed-pages"] !== label ||
      !exactArray(state.Config?.Entrypoint, [
        "/usr/local/bin/ruby",
        "-rjson",
        "-rdigest",
        "-e",
      ]) ||
      !exactArray(state.Config?.Cmd, [childScript]) ||
      state.HostConfig?.NetworkMode !== "none" ||
      state.HostConfig?.ReadonlyRootfs !== true ||
      !exactArray(state.HostConfig?.CapDrop, ["ALL"]) ||
      !exactArray(state.HostConfig?.Binds, [bind]) ||
      !securityOpt.some((item) => item.startsWith("no-new-privileges")) ||
      state.HostConfig?.PidsLimit !== 16 ||
      state.HostConfig?.Memory !== 67108864 ||
      state.HostConfig?.Privileged !== false ||
      mounts.length !== 1 ||
      mounts[0].Type !== "bind" ||
      mounts[0].Source !== hostSource ||
      mounts[0].Destination !== childTarget ||
      mounts[0].RW !== false
    ) {
      throw new Error("daemon changed bind or sibling constraints");
    }

    const started = await requestDocker("POST", `/v1.41/containers/${id}/start`);
    if (started.status !== 204) throw new Error(`start=${started.status}`);
    const waited = await requestDocker(
      "POST",
      `/v1.41/containers/${id}/wait?condition=not-running`,
    );
    if (waited.status !== 200 || json(waited).StatusCode !== 0) {
      throw new Error(`wait=${waited.status}`);
    }
    const output = await requestDocker(
      "GET",
      `/v1.41/containers/${id}/logs?stdout=1&stderr=1`,
    );
    if (output.status !== 200) throw new Error(`logs=${output.status}`);
    host = JSON.parse(logs(output.body).trim());
    requireSummary(host, "host hostname");
    if (host.sha256 === builder.sha256) {
      throw new Error("host bind was not distinct from builder hostname");
    }
  } catch (error) {
    failure = error;
  } finally {
    if (id) {
      try {
        const removed = await requestDocker(
          "DELETE",
          `/v1.41/containers/${id}?force=1&v=1`,
        );
        const missing = await requestDocker("GET", `/v1.41/containers/${id}/json`);
        if (removed.status !== 204 || missing.status !== 404) {
          failure ??= new Error(
            `cleanup delete=${removed.status} verify=${missing.status}`,
          );
        }
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) throw failure;
  return [
      "confirmed",
      "docker_host_file_read=confirmed",
      `host_sha256=${host.sha256}`,
      `host_length=${host.length}`,
      "host_strict_shape=true",
      `builder_sha256=${builder.sha256}`,
      `builder_length=${builder.length}`,
      "builder_strict_shape=true",
      "distinct_from_builder=true",
      "constraints=confirmed",
      "cleanup=confirmed",
    ].join(" ") + "\n";
}

module.exports = { main };

if (require.main === module) {
  main()
    .then((proof) => process.stdout.write(proof))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
