import "dotenv/config";
import http from "http";
import axios from "axios";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import sharp from "sharp";
import cron from "node-cron";

const BASE = "https://www.collegenp.com";
const SECTIONS = ["admission", "vacancy"];
const GRAPH_VERSION = "v21.0";

// ---------- MongoDB ----------
const Post = mongoose.model(
  "Post",
  new mongoose.Schema(
    {
      section: String,
      url: { type: String, unique: true },
      title: String,
      image: String,
      fbPostId: String,
    },
    { timestamps: true }
  )
);

const client = axios.create({
  timeout: 30000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; CollegeNPBot/1.0)" },
});

// ---------- Scraping ----------
const PLACEHOLDER = /government-job-in-nepal|government-school-vacancy-banner/i;

// The real notice image is an /uploads/ image that is NOT wrapped in a link.
function pickNoticeImage($) {
  const imgs = $("img")
    .filter((_, el) => $(el).closest("a").length === 0)
    .map((_, el) => {
      const $el = $(el);
      return $el.attr("data-src") || $el.attr("data-lazy-src") || $el.attr("src");
    })
    .get()
    .filter((src) => src && src.includes("/uploads/") && !PLACEHOLDER.test(src));

  return imgs[0] ? new URL(imgs[0], BASE).href : null;
}

async function scrapeLatest(section) {
  // 1) list page -> candidate posts (only items that carry a date)
  const list = await client.get(`${BASE}/${section}`, {
    params: { _: Date.now() },
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
  });
  const $list = cheerio.load(list.data);

  const re = new RegExp(`^/${section}/[^/]+$`);
  const found = [];
  $list("a[href]").each((i, el) => {
    const u = new URL($list(el).attr("href"), BASE);
    if (!u.hostname.endsWith("collegenp.com") || !re.test(u.pathname)) return;

    const text = $list(el).text().replace(/\s+/g, " ").trim();
    const m = text.match(/(\d{4}-\d{2}-\d{2})/);
    found.push({ url: u.origin + u.pathname, date: m ? m[1] : null, order: i });
  });

  const seen = new Set();
  const uniq = found.filter((f) => !seen.has(f.url) && seen.add(f.url));

  const dated = uniq.filter((f) => f.date);
  const pool = dated.length ? dated : uniq;
  pool.sort(
    (a, b) => (b.date || "").localeCompare(a.date || "") || a.order - b.order
  );

  console.log(
    `[${section}] candidates:`,
    pool.slice(0, 3).map((p) => `${p.date || "no-date"}  ${p.url}`)
  );

  const postUrl = pool[0]?.url;
  if (!postUrl) throw new Error(`No post link found in /${section}`);

  // 2) post page -> title + notice image
  const page = await client.get(postUrl);
  const $ = cheerio.load(page.data);

  const title =
    $('meta[property="og:title"]').attr("content") || $("h1").first().text().trim();
  const image = pickNoticeImage($);

  if (!title) throw new Error(`Missing title: ${postUrl}`);
  if (!image) throw new Error(`Notice image not found: ${postUrl}`);

  return { section, url: postUrl, title: title.trim(), image };
}

// ---------- Facebook ----------
const FB_URL = () =>
  `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.FB_PAGE_ID}/photos`;

async function uploadBytes({ title, image }) {
  const img = await client.get(image, { responseType: "arraybuffer" });
  let buf = Buffer.from(img.data);
  let type = img.headers["content-type"] || "image/jpeg";

  if (/webp/i.test(type) || /\.webp(\?|$)/i.test(image)) {
    buf = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
    type = "image/jpeg";
  }

  const form = new FormData();
  form.append("source", new Blob([buf], { type }), "notice.jpg");
  form.append("caption", title);
  form.append("access_token", process.env.FB_PAGE_TOKEN);

  const res = await axios.post(FB_URL(), form, { maxBodyLength: Infinity });
  return res.data.post_id || res.data.id;
}

async function postToFacebook(item) {
  if (/\.webp(\?|$)/i.test(item.image)) return uploadBytes(item);

  try {
    const res = await axios.post(
      FB_URL(),
      new URLSearchParams({
        url: item.image,
        caption: item.title,
        access_token: process.env.FB_PAGE_TOKEN,
      })
    );
    return res.data.post_id || res.data.id;
  } catch (err) {
    console.warn("URL upload failed, uploading bytes:", err.response?.data || err.message);
    return uploadBytes(item);
  }
}

// ---------- Job ----------
let running = false;

async function run() {
  if (running) return; // never run two jobs at once
  running = true;
  console.log(`--- run started ${new Date().toISOString()} ---`);

  try {
    for (const section of SECTIONS) {
      try {
        const item = await scrapeLatest(section);

        if (await Post.exists({ url: item.url })) {
          console.log(`[${section}] already posted: ${item.title}`);
          continue;
        }

        const fbPostId = await postToFacebook(item);
        await Post.create({ ...item, fbPostId });
        console.log(`[${section}] posted: ${item.title}`);
      } catch (err) {
        console.error(`[${section}] failed:`, err.response?.data || err.message);
      }
    }
  } finally {
    running = false;
    console.log("--- run finished ---");
  }
}

// ---------- Start ----------
await mongoose.connect(process.env.MONGO_URI);
console.log("Mongo connected");

// 8 AM, 1 PM, 5 PM, 9 PM Nepal time
cron.schedule("0 8,13,17,21 * * *", run, { timezone: "Asia/Kathmandu" });

// Web server: keep-alive target + manual trigger
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/") {
      res.end("ok");
    } else if (
      url.pathname === "/run" &&
      process.env.RUN_KEY &&
      url.searchParams.get("key") === process.env.RUN_KEY
    ) {
      run();
      res.end("started");
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  })
  .listen(process.env.PORT || 3000, () => console.log("Server up"));

// Self keep-alive (Render sets RENDER_EXTERNAL_URL automatically)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    axios.get(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }, 10 * 60 * 1000); // every 10 minutes
}

run(); // also check once on startup (duplicates are skipped)