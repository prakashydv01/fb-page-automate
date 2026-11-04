import "dotenv/config";
import axios from "axios";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import sharp from "sharp";

const BASE = "https://www.collegenp.com";
const SECTIONS = ["admission", "vacancy"];
const GRAPH_VERSION = "v21.0"; // change if you want to match your Graph API Explorer version

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
  // 1) list page -> first post link
  const list = await client.get(`${BASE}/${section}`);
  const $list = cheerio.load(list.data);

  const re = new RegExp(`^/${section}/[^/]+$`);
  let postUrl = null;
  $list("a[href]").each((_, el) => {
    const u = new URL($list(el).attr("href"), BASE);
    if (u.hostname.endsWith("collegenp.com") && re.test(u.pathname)) {
      postUrl = u.origin + u.pathname;
      return false; // first match only
    }
  });
  if (!postUrl) throw new Error(`No post link found in /${section}`);

  // 2) post page -> title + notice image
  const page = await client.get(postUrl);
  const $ = cheerio.load(page.data);

  const title =
    $('meta[property="og:title"]').attr("content") || $("h1").first().text().trim();

  const image = pickNoticeImage($);

  if (!title) throw new Error(`Missing title: ${postUrl}`);
  if (!image) throw new Error(`Notice image not found: ${postUrl}`);

  console.log(`[${section}] image: ${image}`);
  return { section, url: postUrl, title: title.trim(), image };
}

// ---------- Facebook ----------
const FB_URL = () =>
  `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.FB_PAGE_ID}/photos`;

// Download the image into memory, convert webp -> jpeg, upload the bytes
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
  // webp: always convert and upload bytes
  if (/\.webp(\?|$)/i.test(item.image)) return uploadBytes(item);

  try {
    // png/jpg: let Facebook fetch the image from its URL
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
    console.warn(
      "URL upload failed, uploading bytes:",
      err.response?.data || err.message
    );
    return uploadBytes(item);
  }
}

// ---------- Job ----------
async function run() {
  let failed = false;

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
      failed = true;
      console.error(`[${section}] failed:`, err.response?.data || err.message);
    }
  }
  return failed;
}

// ---------- Start ----------
await mongoose.connect(process.env.MONGO_URI);
console.log("Mongo connected");

const failed = await run();

await mongoose.disconnect();
process.exit(failed ? 1 : 0); // red X in GitHub Actions if something failed