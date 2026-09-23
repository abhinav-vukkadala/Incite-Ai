import requests
from bs4 import BeautifulSoup


def scrape_article(url: str):
    # 1. Define a User-Agent header so requests aren't blocked
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        )
    }

    try:
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()

        soup = BeautifulSoup(response.text, "html.parser")
        title = soup.find("h1")
        title_text = title.get_text(strip=True) if title else "No H1 Found"

        paragraphs = soup.find_all("p")
        body_paragraphs = []

        for p in paragraphs:
            text = p.get_text(strip=True)
            # Filter out short fragments (e.g., share buttons, copyright)
            if len(text) > 30:
                body_paragraphs.append(text)

        full_body = "\n\n".join(body_paragraphs)
        return {"title": title_text, "body": full_body}

    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    test_url = "https://en.wikipedia.org/wiki/Artificial_intelligence"
    result = scrape_article(test_url)
    print(f"TITLE: {result.get('title')}\n")
    # Prints the first 500 characters
    print(f"BODY SNAPSHOT:\n{result.get('body', '')[:500]}...")
