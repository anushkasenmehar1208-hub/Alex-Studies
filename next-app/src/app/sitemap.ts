import type { MetadataRoute } from "next";

const routes = [
  "/",
  "/select",
  "/login",
  "/generate-plan",
  "/exam-forecast",
  "/learn-with-youtube",
];

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((route) => ({
    url: `https://alexstudies.com${route}`,
    lastModified: new Date(),
    changeFrequency: route === "/" ? "weekly" : "monthly",
    priority: route === "/" ? 1 : 0.8,
  }));
}
