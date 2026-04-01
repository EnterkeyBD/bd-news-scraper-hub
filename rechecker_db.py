import mysql.connector
from mysql.connector import errorcode

def get_connection():
    """Establish a connection to the database."""
    return mysql.connector.connect(
        host="103.213.38.238",
        port=3306,
        user="siamvidb_scraptestg",
        password="HuHmf!w=E]%I=3L&",
        database="siamvidb_scraptestg",
        charset="utf8mb4"
    )

def ensure_schema():
    """Ensure the articles table has 'updated_at' and 'update' columns."""
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS updated_at DATETIME NULL AFTER image_name;")
    except Exception as e:
        if 'Duplicate column name' not in str(e):
            print(f"Error adding updated_at column: {e}")
    try:
        cursor.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS `update` INT DEFAULT 0 AFTER updated_at;")
    except Exception as e:
        if 'Duplicate column name' not in str(e):
            print(f"Error adding update column: {e}")
    conn.commit()
    cursor.close()
    conn.close()

def get_all_articles():
    """Fetch all articles from the database."""
    conn = get_connection()
    cursor = conn.cursor(dictionary=True)
    sql = "SELECT * FROM articles"
    try:
        cursor.execute(sql)
        return cursor.fetchall()
    finally:
        cursor.close()
        conn.close()

def update_article_on_recheck(article_id, headline, content, image_name):
    """Update an article's details after rechecking, increment update count, set updated_at."""
    conn = get_connection()
    cursor = conn.cursor()
    sql = """
        UPDATE articles
        SET headline = %s, content = %s, image_name = %s, updated_at = NOW(), `update` = IFNULL(`update`,0) + 1
        WHERE id = %s
    """
    try:
        cursor.execute(sql, (headline, content, image_name, article_id))
        conn.commit()
    finally:
        cursor.close()
        conn.close()