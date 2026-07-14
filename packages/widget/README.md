# @asksql/widget

The vanilla JavaScript embed for [AskSQL](https://github.com/rahulmahadik/AskSQL). One script tag mounts the
chat bubble on any page, React or not. Rendered inside shadow DOM so your
page styles and the widget styles never collide.

```html
<script src="asksql-widget.js"></script>
<script>
  AskSQL.mount({ serverUrl: '/asksql', position: 'bottom-right' });
</script>
```

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
