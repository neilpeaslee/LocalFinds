import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/localfinds start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :localfinds, LocalfindsWeb.Endpoint, server: true
end

config :localfinds, LocalfindsWeb.Endpoint,
  http: [port: String.to_integer(System.get_env("PORT", "4000"))]

if config_env() == :prod do
  config :localfinds, Localfinds.Repo,
    url: System.fetch_env!("DATABASE_URL"),
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "5")

  config :localfinds, :bearer_token, System.fetch_env!("BEARER_TOKEN")

  config :localfinds, LocalfindsWeb.Endpoint,
    url: [host: System.fetch_env!("PHX_HOST"), port: 443, scheme: "https"],
    http: [ip: {127, 0, 0, 1}, port: String.to_integer(System.get_env("PORT") || "4000")],
    secret_key_base: System.fetch_env!("SECRET_KEY_BASE")
end
