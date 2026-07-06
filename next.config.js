/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // sharp/ffmpeg-static/fluent-ffmpeg bundle native binaries — keep them out
  // of webpack/turbopack's own bundling and let Next trace them as plain
  // files instead.
  serverExternalPackages: ['sharp', 'fluent-ffmpeg', 'ffmpeg-static'],
};

module.exports = nextConfig;
