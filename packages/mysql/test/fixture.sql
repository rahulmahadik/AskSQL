-- AskSQL MySQL introspection fixture: the object types packages/mysql/test/live.test.ts asserts on.
-- Load with: mysql -uroot asksql_test < packages/mysql/test/fixture.sql
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS shops;
DROP VIEW IF EXISTS in_stock;

CREATE TABLE shops (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  country ENUM('US','UK','IN','DE') NOT NULL
) COMMENT 'Shops in the chain';

CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shop_id INT NOT NULL,
  sku VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  price_cents BIGINT NOT NULL,
  weight DECIMAL(6,3) NULL,
  stock INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_products_shop FOREIGN KEY (shop_id) REFERENCES shops(id),
  CONSTRAINT uq_products_shop_sku UNIQUE (shop_id, sku)
) COMMENT 'Products per shop';

CREATE INDEX ix_products_price ON products(price_cents);

CREATE VIEW in_stock AS SELECT id, shop_id, name, stock FROM products WHERE stock > 0;

CREATE TRIGGER trg_products_bi BEFORE INSERT ON products
FOR EACH ROW SET NEW.sku = UPPER(NEW.sku);

INSERT INTO shops (name, country) VALUES ('North Store','US'), ('South Store','UK');
INSERT INTO products (shop_id, sku, name, price_cents, weight, stock) VALUES
  (1,'sku-1','Widget',999999999999,2.750,5),
  (1,'sku-2','Gadget',250000,1.500,0),
  (2,'sku-3','Doohickey',12500,0.250,12);
