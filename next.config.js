/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // sharp/ffmpeg-static/fluent-ffmpeg bundle native binaries — keep them out
  // of webpack/turbopack's own bundling and let Next trace them as plain
  // files instead.
  serverExternalPackages: ['sharp', 'fluent-ffmpeg', 'ffmpeg-static'],
  // Lets `next dev` accept requests from a phone on the same LAN (e.g.
  // http://192.168.1.x:3000) for on-device testing — dev-only, has no
  // effect on a production build/deploy. Wildcarded to the whole subnet
  // (Next matches '*' as one dot-separated segment, same as a domain
  // wildcard) rather than one pinned IP, since a phone's LAN address is
  // DHCP-assigned and can change between sessions.
  allowedDevOrigins: ['192.168.1.*'],
};

module.exports = nextConfig;
