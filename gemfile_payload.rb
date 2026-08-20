# frozen_string_literal: true

marker = "MANAGED_PAGES_GEMFILE_APP_EXEC_20260820"
workspace = ENV.fetch("GITHUB_WORKSPACE", "/github/workspace")
identity = `/usr/bin/id`.strip
token_state = ENV["INPUT_TOKEN"].to_s.empty? ? "absent" : "present"
runtime_token_state = ENV["ACTIONS_RUNTIME_TOKEN"].to_s.empty? ? "absent" : "present"
docker_state = File.socket?("/var/run/docker.sock") ? "present" : "absent"
runner_temp_roundtrip = "absent"
docker_sibling_roundtrip = "absent"
docker_host_proof = "docker_host_file_read=absent"

runner_temp_marker = "/github/runner_temp/managed-pages-gemfile-host-marker"
if Dir.exist?("/github/runner_temp")
  File.write(runner_temp_marker, marker)
  runner_temp_roundtrip = "confirmed" if File.read(runner_temp_marker) == marker
  File.delete(runner_temp_marker) if File.exist?(runner_temp_marker)
end

if docker_state == "present"
  helper = File.join(workspace, "managed-pages-gemfile-docker-control.cjs")
  sibling_proof = IO.popen(["node", helper], err: File::NULL, &:read).strip
  if sibling_proof.start_with?("confirmed docker_host_file_read=confirmed ")
    docker_sibling_roundtrip = "confirmed"
    docker_host_proof = sibling_proof.delete_prefix("confirmed ")
  end
end

result = [
  marker,
  %(identity="#{identity}"),
  "input_token=#{token_state}",
  "runtime_token=#{runtime_token_state}",
  "docker_socket=#{docker_state}",
  "runner_temp_roundtrip=#{runner_temp_roundtrip}",
  "docker_sibling_roundtrip=#{docker_sibling_roundtrip}",
  docker_host_proof,
].join(" ")
File.write(File.join(workspace, "#{marker}.txt"), "#{result}\n")
warn result
