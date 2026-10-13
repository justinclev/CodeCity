package messaging

import (
	"regexp"
	"strings"
)

// Other brokers: first-argument call patterns, applied to every supported language
// once the file mentions the broker.

const ctxArg = `(?:(?:ctx|context\.Background\(\)|context\.TODO\(\))\s*,\s*)?`

type rule struct {
	re   *regexp.Regexp
	dir  string
	grp  int  // group holding the topic (or list)
	list bool // the group is a comma-separated list
}

type broker struct {
	name    string
	markers []string
	rules   []rule
}

func r(dir, pat string, grp int, list bool) rule {
	return rule{regexp.MustCompile(pat), dir, grp, list}
}

var brokers = []broker{
	{"nats", []string{"nats"}, []rule{
		r(Pub, `\.(?:Publish|PublishMsg|PublishAsync|Request|publish|request)\(\s*(`+expr+`)`, 1, false),
		r(Sub, `\.(?:Subscribe|QueueSubscribe|SubscribeSync|QueueSubscribeSync|ChanSubscribe|subscribe)\(\s*(`+expr+`)`, 1, false),
	}},
	{"redis", []string{"redis"}, []rule{
		r(Pub, `\.(?:Publish|publish)\(\s*`+ctxArg+`(`+expr+`)\s*,`, 1, false),
		r(Sub, `\.(?:Subscribe|PSubscribe|subscribe|psubscribe)\(\s*`+ctxArg+`(`+expr+`)`, 1, false),
	}},
	{"mqtt", []string{"mqtt"}, []rule{
		r(Pub, `\.(?:Publish|publish)\(\s*(`+expr+`)`, 1, false),
		r(Sub, `\.(?:Subscribe|subscribe)\(\s*(`+expr+`)`, 1, false),
	}},
	{"amqp", []string{"amqp", "rabbitmq", "pika"}, []rule{
		r(Pub, `\.(?:Publish|PublishWithContext)\(\s*`+ctxArg+`(?:`+expr+`)\s*,\s*(`+expr+`)`, 1, false),
		r(Pub, `\bsendToQueue\(\s*(`+expr+`)`, 1, false),
		r(Pub, `basic_publish\([^)]*routing_key\s*=\s*(`+expr+`)`, 1, false),
		r(Sub, `\.(?:Consume|consume)\(\s*(`+expr+`)`, 1, false),
		r(Sub, `basic_consume\([^)]*queue\s*=\s*(`+expr+`)`, 1, false),
	}},
}

var sqsRe = regexp.MustCompile(`\b(QueueUrl|TopicArn)\b["']?\s*[:=]\s*(` + expr + `)`)

// others scans for NATS, Redis, MQTT, AMQP (RabbitMQ), SQS and SNS.
func (s *scanner) others(path, lower string) {
	if !isJS(path) && !strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, ".py") && !strings.HasSuffix(path, ".rs") {
		return
	}
	for _, b := range brokers {
		found := false
		for _, m := range b.markers {
			if strings.Contains(lower, m) {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		s.broker = b.name
		for _, ru := range b.rules {
			for _, m := range ru.re.FindAllSubmatchIndex(s.src, -1) {
				if ru.grp*2+1 >= len(m) || m[2*ru.grp] < 0 {
					continue
				}
				v, off := string(s.src[m[2*ru.grp]:m[2*ru.grp+1]]), m[2*ru.grp]
				if ru.list {
					s.list(v, off, ru.dir)
				} else {
					s.add(ru.dir, v, off)
				}
			}
		}
	}
	if strings.Contains(lower, "sqs") || strings.Contains(lower, "sns") || strings.Contains(lower, "queueurl") || strings.Contains(lower, "topicarn") {
		for _, m := range sqsRe.FindAllSubmatchIndex(s.src, -1) {
			key, v, off := string(s.src[m[2]:m[3]]), string(s.src[m[4]:m[5]]), m[4]
			val := resolve(v, s.consts)
			if val == "" {
				continue
			}
			// the queue / topic is named by the last segment of the URL or ARN
			name := val[strings.LastIndexAny(val, "/:")+1:]
			ctx := strings.ToLower(string(s.src[max(0, m[0]-300):m[0]]))
			dir := Pub
			if i, j := strings.LastIndex(ctx, "receive"), strings.LastIndex(ctx, "send"); i > j || strings.LastIndex(ctx, "consume") > j {
				dir = Sub
			}
			s.broker = "sqs"
			if key == "TopicArn" {
				s.broker = "sns"
			}
			s.add(dir, `"`+name+`"`, off)
		}
	}
}
