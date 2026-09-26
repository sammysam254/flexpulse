import React, { useEffect } from 'react';

/**
 * SEO Component for dynamic head management without external dependencies.
 * @param {Object} props
 * @param {string} props.title - Dynamic document title
 * @param {string} props.description - Meta description
 * @param {string} [props.keywords] - Meta keywords comma-separated
 * @param {string} [props.canonical] - Canonical URL
 * @param {string} [props.ogType='website'] - Open Graph type
 * @param {string} [props.ogImage] - Open Graph image URL
 * @param {Object} [props.jsonLd] - Structured Data JSON-LD object
 * @param {boolean} [props.noIndex=false] - Whether to disallow indexing for private screens
 */
export default function SEO({
  title,
  description,
  keywords,
  canonical,
  ogType = 'website',
  ogImage = '/og-banner.png',
  jsonLd,
  noIndex = false
}) {
  useEffect(() => {
    // 1. Update Title
    if (title) {
      document.title = title.includes('Flexpulse') ? title : `${title} | Flexpulse Rentals`;
    }

    // 2. Update Helper Meta Functions
    const setMetaTag = (attrName, attrValue, content) => {
      if (!content) return;
      let element = document.querySelector(`meta[${attrName}="${attrValue}"]`);
      if (!element) {
        element = document.createElement('meta');
        element.setAttribute(attrName, attrValue);
        document.head.appendChild(element);
      }
      element.setAttribute('content', content);
    };

    // 3. Set Primary Meta Tags
    setMetaTag('name', 'description', description);
    if (keywords) setMetaTag('name', 'keywords', keywords);
    setMetaTag('name', 'robots', noIndex ? 'noindex, nofollow' : 'index, follow');

    // 4. Open Graph Tags
    setMetaTag('property', 'og:title', title);
    setMetaTag('property', 'og:description', description);
    setMetaTag('property', 'og:type', ogType);
    if (ogImage) setMetaTag('property', 'og:image', ogImage);

    // 5. Twitter Card Tags
    setMetaTag('name', 'twitter:title', title);
    setMetaTag('name', 'twitter:description', description);
    if (ogImage) setMetaTag('name', 'twitter:image', ogImage);

    // 6. Canonical Link
    if (canonical) {
      let link = document.querySelector('link[rel="canonical"]');
      if (!link) {
        link = document.createElement('link');
        link.setAttribute('rel', 'canonical');
        document.head.appendChild(link);
      }
      link.setAttribute('href', canonical);
    }

    // 7. Dynamic JSON-LD Schema
    let scriptTag = document.getElementById('dynamic-jsonld');
    if (jsonLd) {
      if (!scriptTag) {
        scriptTag = document.createElement('script');
        scriptTag.id = 'dynamic-jsonld';
        scriptTag.type = 'application/ld+json';
        document.head.appendChild(scriptTag);
      }
      scriptTag.textContent = JSON.stringify(jsonLd);
    } else if (scriptTag) {
      scriptTag.remove();
    }
  }, [title, description, keywords, canonical, ogType, ogImage, jsonLd, noIndex]);

  return null;
}
