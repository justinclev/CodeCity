package messaging

import (
	"encoding/json"
	"regexp"
	"strings"
)

var (
	asyncTop      = regexp.MustCompile(`(?m)^["']?asyncapi["']?\s*:`)
	asyncProtocol = regexp.MustCompile(`(?m)^\s*protocol\s*:\s*["']?([\w-]+)["']?`)
	yamlKey       = regexp.MustCompile(`^(\s*)["']?([^"':\s][^"':]*?)["']?\s*:\s*(.*)$`)
)

func brokerOf(protocol string) string {
	switch strings.ToLower(protocol) {
	case "kafka", "kafka-secure":
		return "kafka"
	case "amqp", "amqps":
		return "amqp"
	case "mqtt", "mqtts", "secure-mqtt":
		return "mqtt"
	case "nats":
		return "nats"
	case "redis":
		return "redis"
	case "sqs":
		return "sqs"
	case "sns":
		return "sns"
	}
	return protocol
}

// AsyncAPI reads the channels an AsyncAPI document says the application sends to or receives from.
// v3 states it directly (action: send / receive). v2 states it from the other side: a "publish"
// operation means others publish to the channel because this application consumes it, and
// "subscribe" means others subscribe because this application publishes.
func AsyncAPI(path string, src []byte) []Op {
	lname := strings.ToLower(path)
	text := string(src)
	if strings.HasSuffix(lname, ".json") {
		var doc struct {
			Asyncapi string `json:"asyncapi"`
			Servers  map[string]struct {
				Protocol string `json:"protocol"`
			} `json:"servers"`
			Channels map[string]struct {
				Address   string          `json:"address"`
				Publish   json.RawMessage `json:"publish"`
				Subscribe json.RawMessage `json:"subscribe"`
			} `json:"channels"`
			Operations map[string]struct {
				Action  string `json:"action"`
				Channel struct {
					Ref string `json:"$ref"`
				} `json:"channel"`
			} `json:"operations"`
		}
		if json.Unmarshal(src, &doc) != nil || doc.Asyncapi == "" {
			return nil
		}
		broker := "asyncapi"
		for _, s := range doc.Servers {
			broker = brokerOf(s.Protocol)
			break
		}
		var out []Op
		for name, ch := range doc.Channels {
			topic := name
			if ch.Address != "" {
				topic = ch.Address
			}
			if len(ch.Publish) > 0 {
				out = append(out, Op{Dir: Sub, Broker: broker, Topic: topic})
			}
			if len(ch.Subscribe) > 0 {
				out = append(out, Op{Dir: Pub, Broker: broker, Topic: topic})
			}
		}
		for _, op := range doc.Operations {
			name := op.Channel.Ref[strings.LastIndexByte(op.Channel.Ref, '/')+1:]
			ch, ok := doc.Channels[name]
			if !ok {
				continue
			}
			topic := name
			if ch.Address != "" {
				topic = ch.Address
			}
			switch op.Action {
			case "send":
				out = append(out, Op{Dir: Pub, Broker: broker, Topic: topic})
			case "receive":
				out = append(out, Op{Dir: Sub, Broker: broker, Topic: topic})
			}
		}
		return clean(out)
	}
	if !(strings.HasSuffix(lname, ".yaml") || strings.HasSuffix(lname, ".yml")) || !asyncTop.MatchString(text) {
		return nil
	}
	broker := "asyncapi"
	if m := asyncProtocol.FindStringSubmatch(text); m != nil {
		broker = brokerOf(m[1])
	}
	v3 := regexp.MustCompile(`(?m)^["']?asyncapi["']?\s*:\s*["']?3`).MatchString(text)
	type chInfo struct{ address string }
	channels := map[string]*chInfo{}
	var out []Op
	section := ""
	chIndent, curCh := -1, ""
	opName, opAction, opChan := "", "", ""
	flushOp := func() {
		if opAction != "" && opChan != "" {
			if ci := channels[opChan]; ci != nil {
				topic := opChan
				if ci.address != "" {
					topic = ci.address
				}
				dir := Sub
				if opAction == "send" {
					dir = Pub
				}
				out = append(out, Op{Dir: dir, Broker: broker, Topic: topic})
			}
		}
		opName, opAction, opChan = "", "", ""
	}
	var pending []struct {
		ch, dir string
	}
	for _, ln := range strings.Split(text, "\n") {
		t := strings.TrimSpace(ln)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		m := yamlKey.FindStringSubmatch(ln)
		if m == nil {
			continue
		}
		indent, key, val := len(m[1]), m[2], strings.Trim(strings.TrimSpace(m[3]), `"'`)
		if indent == 0 {
			if section == "operations" {
				flushOp()
			}
			section = key
			chIndent, curCh = -1, ""
			continue
		}
		switch section {
		case "channels":
			if chIndent < 0 {
				chIndent = indent
			}
			switch {
			case indent == chIndent:
				curCh = key
				if channels[curCh] == nil {
					channels[curCh] = &chInfo{}
				}
			case curCh != "" && key == "address" && val != "":
				channels[curCh].address = val
			case curCh != "" && !v3 && indent == chIndent+2 && key == "publish":
				pending = append(pending, struct{ ch, dir string }{curCh, Sub})
			case curCh != "" && !v3 && indent == chIndent+2 && key == "subscribe":
				pending = append(pending, struct{ ch, dir string }{curCh, Pub})
			}
		case "operations":
			if v3 && indent <= 2 && val == "" {
				flushOp()
				opName = key
			} else if opName != "" {
				switch key {
				case "action":
					opAction = val
				case "$ref":
					opChan = val[strings.LastIndexByte(val, '/')+1:]
				}
			}
		}
	}
	if section == "operations" {
		flushOp()
	}
	for _, p := range pending {
		topic := p.ch
		if ci := channels[p.ch]; ci != nil && ci.address != "" {
			topic = ci.address
		}
		out = append(out, Op{Dir: p.dir, Broker: broker, Topic: topic})
	}
	return clean(out)
}

func clean(ops []Op) []Op {
	seen := map[Op]bool{}
	var out []Op
	for _, o := range ops {
		o.Topic = strings.TrimSpace(o.Topic)
		if o.Topic == "" || strings.ContainsAny(o.Topic, "{}*") || seen[o] {
			continue
		}
		seen[o] = true
		out = append(out, o)
	}
	return out
}
